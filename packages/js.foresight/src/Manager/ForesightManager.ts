import { tabbable, type FocusableElement } from "tabbable"
import { evaluateRegistrationConditions } from "../helpers/shouldRegister"
import type {
  CallbackHits,
  ElementUnregisteredReason,
  ForesightElement,
  ForesightElementData,
  ForesightEventMap,
  ForesightEventType,
  ForesightManagerData,
  ForesightManagerSettings,
  ForesightRegisterOptions,
  ForesightRegisterResult,
  HitType,
  ManagerBooleanSettingKeys,
  NumericSettingKeys,
  Point,
  ScrollDirection,
  TrajectoryPositions,
  UpdateForsightManagerSettings,
} from "../types/types"
import {
  DEFAULT_ENABLE_MOUSE_PREDICTION,
  DEFAULT_ENABLE_SCROLL_PREDICTION,
  DEFAULT_ENABLE_TAB_PREDICTION,
  DEFAULT_HITSLOP,
  DEFAULT_POSITION_HISTORY_SIZE,
  DEFAULT_SCROLL_MARGIN,
  DEFAULT_TAB_OFFSET,
  DEFAULT_TRAJECTORY_PREDICTION_TIME,
  MAX_POSITION_HISTORY_SIZE,
  MAX_SCROLL_MARGIN,
  MAX_TAB_OFFSET,
  MAX_TRAJECTORY_PREDICTION_TIME,
  MIN_POSITION_HISTORY_SIZE,
  MIN_SCROLL_MARGIN,
  MIN_TAB_OFFSET,
  MIN_TRAJECTORY_PREDICTION_TIME,
} from "./constants"
import { clampNumber } from "./helpers/clampNumber"
import { lineSegmentIntersectsRect } from "./helpers/lineSigmentIntersectsRect"
import { predictNextMousePosition } from "./helpers/predictNextMousePosition"
import {
  areRectsEqual,
  getExpandedRect,
  isPointInRectangle,
  normalizeHitSlop,
} from "./helpers/rectAndHitSlop"
import { shouldUpdateSetting } from "./helpers/shouldUpdateSetting"
import { getFocusedElementIndex } from "./helpers/getFocusedElementIndex"
import { getScrollDirection } from "./helpers/getScrollDirection"
import { predictNextScrollPosition } from "./helpers/predictNextScrollPosition"
import { PositionObserver, PositionObserverEntry } from "position-observer"

/**
 * Manages the prediction of user intent based on mouse trajectory and element interactions.
 *
 * ForesightManager is a singleton class responsible for:
 * - Registering HTML elements to monitor.
 * - Tracking mouse movements and predicting future cursor positions.
 * - Detecting when a predicted trajectory intersects with a registered element's bounds.
 * - Invoking callbacks associated with elements upon predicted or actual interaction.
 * - Optionally unregistering elements after their callback is triggered.
 * - Handling global settings for prediction behavior (e.g., history size, prediction time).
 * - Automatically updating element bounds on resize using {@link ResizeObserver}.
 * - Automatically unregistering elements removed from the DOM using {@link MutationObserver}.
 * - Detecting broader layout shifts via {@link MutationObserver} to update element positions.
 *
 * It should be initialized once using {@link ForesightManager.initialize} and then
 * accessed via the static getter {@link ForesightManager.instance}.
 */

export class ForesightManager {
  private static manager: ForesightManager
  private elements: Map<ForesightElement, ForesightElementData> = new Map()
  private isSetup: boolean = false
  private _globalCallbackHits: CallbackHits = {
    mouse: {
      hover: 0,
      trajectory: 0,
    },
    tab: {
      forwards: 0,
      reverse: 0,
    },
    scroll: {
      down: 0,
      left: 0,
      right: 0,
      up: 0,
    },
    total: 0,
  }
  private _globalSettings: ForesightManagerSettings = {
    debug: false,
    enableMousePrediction: DEFAULT_ENABLE_MOUSE_PREDICTION,
    enableScrollPrediction: DEFAULT_ENABLE_SCROLL_PREDICTION,
    positionHistorySize: DEFAULT_POSITION_HISTORY_SIZE,
    trajectoryPredictionTime: DEFAULT_TRAJECTORY_PREDICTION_TIME,
    scrollMargin: DEFAULT_SCROLL_MARGIN,
    defaultHitSlop: {
      top: DEFAULT_HITSLOP,
      left: DEFAULT_HITSLOP,
      right: DEFAULT_HITSLOP,
      bottom: DEFAULT_HITSLOP,
    },
    enableTabPrediction: DEFAULT_ENABLE_TAB_PREDICTION,
    tabOffset: DEFAULT_TAB_OFFSET,
    onAnyCallbackFired: (
      _elementData: ForesightElementData,
      _managerData: ForesightManagerData
    ) => {},
  }
  private trajectoryPositions: TrajectoryPositions = {
    positions: [],
    currentPoint: { x: 0, y: 0 },
    predictedPoint: { x: 0, y: 0 },
  }

  private tabbableElementsCache: FocusableElement[] = []
  private lastFocusedIndex: number | null = null

  private predictedScrollPoint: Point | null = null
  private scrollDirection: ScrollDirection | null = null
  private domObserver: MutationObserver | null = null
  private positionObserver: PositionObserver | null = null
  // Track the last keydown event to determine if focus change was due to Tab
  private lastKeyDown: KeyboardEvent | null = null

  // AbortController for managing global event listeners
  private globalListenersController: AbortController | null = null

  private eventListeners: Map<ForesightEventType, ((event: any) => void)[]> = new Map()

  // Never put something in the constructor, use initialize instead
  private constructor() {}

  public static initialize(props?: Partial<UpdateForsightManagerSettings>): ForesightManager {
    if (!this.isInitiated) {
      ForesightManager.manager = new ForesightManager()
    }
    if (props !== undefined) {
      ForesightManager.manager.alterGlobalSettings(props)
    }
    return ForesightManager.manager
  }

  public addEventListener<K extends ForesightEventType>(
    eventType: K,
    listener: (event: ForesightEventMap[K]) => void,
    options?: { signal?: AbortSignal }
  ) {
    if (options?.signal?.aborted) {
      return () => {}
    }
    if (!this.eventListeners.has(eventType)) {
      this.eventListeners.set(eventType, [])
    }
    this.eventListeners.get(eventType)!.push(listener)

    options?.signal?.addEventListener("abort", () => this.removeEventListener(eventType, listener))
  }

  public removeEventListener<K extends ForesightEventType>(
    eventType: K,
    listener: (event: ForesightEventMap[K]) => void
  ): void {
    const listeners = this.eventListeners.get(eventType)
    if (listeners) {
      const index = listeners.indexOf(listener)
      if (index > -1) {
        listeners.splice(index, 1)
      }
    }
  }

  // Used for debugging only
  public logSubscribers(): void {
    console.log("%c[ForesightManager] Current Subscribers:", "font-weight: bold; color: #3b82f6;")

    const eventTypes = Array.from(this.eventListeners.keys())

    if (eventTypes.length === 0) {
      console.log("  No active subscribers.")
      return
    }

    eventTypes.forEach(eventType => {
      const listeners = this.eventListeners.get(eventType)

      if (listeners && listeners.length > 0) {
        // Use groupCollapsed so the log isn't too noisy by default.
        // The user can expand the events they are interested in.
        console.groupCollapsed(
          `Event: %c${eventType}`,
          "font-weight: bold;",
          `(${listeners.length} listener${listeners.length > 1 ? "s" : ""})`
        )

        listeners.forEach((listener, index) => {
          console.log(`[${index}]:`, listener)
        })

        console.groupEnd()
      }
    })
  }

  private emit<K extends ForesightEventType>(event: { type: K } & ForesightEventMap[K]): void {
    const listeners = this.eventListeners.get(event.type)
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(event)
        } catch (error) {
          console.error(`Error in ForesightManager event listener for ${event.type}:`, error)
        }
      })
    }
  }

  public get getManagerData(): Readonly<ForesightManagerData> {
    return {
      registeredElements: this.elements,
      globalSettings: this._globalSettings,
      globalCallbackHits: this._globalCallbackHits,
    }
  }

  public static get isInitiated(): Readonly<boolean> {
    return !!ForesightManager.manager
  }

  public static get instance(): ForesightManager {
    return this.initialize()
  }

  public get registeredElements(): ReadonlyMap<ForesightElement, ForesightElementData> {
    return this.elements
  }

  public register({
    element,
    callback,
    hitSlop,
    name,
  }: ForesightRegisterOptions): ForesightRegisterResult {
    const { shouldRegister, isTouchDevice, isLimitedConnection } = evaluateRegistrationConditions()
    if (!shouldRegister) {
      return {
        isLimitedConnection,
        isTouchDevice,
        isRegistered: false,
        unregister: () => {},
      }
    }

    // Setup global listeners on every first element added to the manager. It gets removed again when the map is emptied
    if (!this.isSetup) {
      this.initializeGlobalListeners()
    }

    const normalizedHitSlop = hitSlop
      ? normalizeHitSlop(hitSlop)
      : this._globalSettings.defaultHitSlop
    // const elementRect = element.getBoundingClientRect()
    const elementData: ForesightElementData = {
      element: element,
      callback,
      callbackHits: {
        mouse: {
          hover: 0,
          trajectory: 0,
        },
        tab: {
          forwards: 0,
          reverse: 0,
        },
        scroll: {
          down: 0,
          left: 0,
          right: 0,
          up: 0,
        },
        total: 0,
      },
      elementBounds: {
        originalRect: undefined,
        expandedRect: { top: 0, left: 0, right: 0, bottom: 0 },
        hitSlop: normalizedHitSlop,
      },
      isHovering: false,
      trajectoryHitData: {
        isTrajectoryHit: false,
        trajectoryHitTime: 0,
        trajectoryHitExpirationTimeoutId: undefined,
      },
      name: name ?? element.id ?? "",
      isIntersectingWithViewport: true,
    }

    this.elements.set(element, elementData)

    this.positionObserver?.observe(element)

    this.emit({
      type: "elementRegistered",
      timestamp: Date.now(),
      elementData,
    })

    return {
      isTouchDevice,
      isLimitedConnection,
      isRegistered: true,
      unregister: () => this.unregister(element, "apiCall"),
    }
  }

  private unregister(element: ForesightElement, unregisterReason: ElementUnregisteredReason) {
    if (!this.elements.has(element)) {
      return
    }

    const foresightElementData = this.elements.get(element)

    if (foresightElementData) {
      this.emit({
        type: "elementUnregistered",
        elementData: foresightElementData,
        timestamp: Date.now(),
        unregisterReason: unregisterReason,
      })
    }

    // Clear any pending trajectory expiration timeout
    if (foresightElementData?.trajectoryHitData.trajectoryHitExpirationTimeoutId) {
      clearTimeout(foresightElementData.trajectoryHitData.trajectoryHitExpirationTimeoutId)
    }

    this.positionObserver?.unobserve(element)
    this.elements.delete(element)

    if (this.elements.size === 0 && this.isSetup) {
      this.removeGlobalListeners()
    }
  }

  private updateNumericSettings(
    newValue: number | undefined,
    setting: NumericSettingKeys,
    min: number,
    max: number
  ) {
    if (!shouldUpdateSetting(newValue, this._globalSettings[setting])) {
      return false
    }

    this._globalSettings[setting] = clampNumber(newValue, min, max, setting)

    return true
  }

  private updateBooleanSetting(
    newValue: boolean | undefined,
    setting: ManagerBooleanSettingKeys
  ): boolean {
    if (!shouldUpdateSetting(newValue, this._globalSettings[setting])) {
      return false
    }
    this._globalSettings[setting] = newValue
    return true
  }

  public alterGlobalSettings(props?: Partial<UpdateForsightManagerSettings>): void {
    // Call each update function and store whether it made a change.
    // This ensures every update function is executed.
    const oldPositionHistorySize = this._globalSettings.positionHistorySize
    const positionHistoryChanged = this.updateNumericSettings(
      props?.positionHistorySize,
      "positionHistorySize",
      MIN_POSITION_HISTORY_SIZE,
      MAX_POSITION_HISTORY_SIZE
    )

    if (
      positionHistoryChanged &&
      this._globalSettings.positionHistorySize < oldPositionHistorySize
    ) {
      if (this.trajectoryPositions.positions.length > this._globalSettings.positionHistorySize) {
        this.trajectoryPositions.positions = this.trajectoryPositions.positions.slice(
          this.trajectoryPositions.positions.length - this._globalSettings.positionHistorySize
        )
      }
    }

    const trajectoryTimeChanged = this.updateNumericSettings(
      props?.trajectoryPredictionTime,
      "trajectoryPredictionTime",
      MIN_TRAJECTORY_PREDICTION_TIME,
      MAX_TRAJECTORY_PREDICTION_TIME
    )

    const scrollMarginChanged = this.updateNumericSettings(
      props?.scrollMargin,
      "scrollMargin",
      MIN_SCROLL_MARGIN,
      MAX_SCROLL_MARGIN
    )

    const tabOffsetChanged = this.updateNumericSettings(
      props?.tabOffset,
      "tabOffset",
      MIN_TAB_OFFSET,
      MAX_TAB_OFFSET
    )

    const mousePredictionChanged = this.updateBooleanSetting(
      props?.enableMousePrediction,
      "enableMousePrediction"
    )

    const scrollPredictionChanged = this.updateBooleanSetting(
      props?.enableScrollPrediction,
      "enableScrollPrediction"
    )

    const tabPredictionChanged = this.updateBooleanSetting(
      props?.enableTabPrediction,
      "enableTabPrediction"
    )

    if (props?.onAnyCallbackFired !== undefined) {
      this._globalSettings.onAnyCallbackFired = props.onAnyCallbackFired
    }

    let hitSlopChanged = false
    if (props?.defaultHitSlop !== undefined) {
      const normalizedNewHitSlop = normalizeHitSlop(props.defaultHitSlop)
      if (!areRectsEqual(this._globalSettings.defaultHitSlop, normalizedNewHitSlop)) {
        this._globalSettings.defaultHitSlop = normalizedNewHitSlop
        hitSlopChanged = true
        this.forceUpdateAllElementBounds()
      }
    }

    const settingsActuallyChanged =
      positionHistoryChanged ||
      trajectoryTimeChanged ||
      tabOffsetChanged ||
      mousePredictionChanged ||
      tabPredictionChanged ||
      scrollPredictionChanged ||
      hitSlopChanged ||
      scrollMarginChanged

    if (settingsActuallyChanged) {
      this.emit({
        type: "managerSettingsChanged",
        timestamp: Date.now(),
        newSettings: this._globalSettings,
      })
    }
  }

  private forceUpdateAllElementBounds() {
    this.elements.forEach((_, element) => {
      const elementData = this.elements.get(element)
      // For performance only update rects that are currently intersecting with the viewport
      if (elementData && elementData.isIntersectingWithViewport) {
        this.forceUpdateElementBounds(elementData)
      }
    })
  }

  private updatePointerState(e: MouseEvent): void {
    this.trajectoryPositions.currentPoint = { x: e.clientX, y: e.clientY }
    this.trajectoryPositions.predictedPoint = this._globalSettings.enableMousePrediction
      ? predictNextMousePosition(
          this.trajectoryPositions.currentPoint,
          this.trajectoryPositions.positions, // History before the currentPoint was added
          this._globalSettings.positionHistorySize,
          this._globalSettings.trajectoryPredictionTime
        )
      : { ...this.trajectoryPositions.currentPoint }
  }

  /**
   * Processes elements that unregister after a single callback.
   *
   * This is a "fire-and-forget" handler. Its only goal is to trigger the
   * callback once. It does so if the mouse trajectory is predicted to hit the
   * element (if prediction is on) OR if the mouse physically hovers over it.
   * It does not track state, as the element is immediately unregistered.
   *
   * @param elementData - The data object for the foresight element.
   * @param element - The HTML element being interacted with.
   */
  private handleCallbackInteraction(elementData: ForesightElementData) {
    const { expandedRect } = elementData.elementBounds

    // when enable mouse prediction is off, we only check if the mouse is physically hovering over the element
    if (!this._globalSettings.enableMousePrediction) {
      if (isPointInRectangle(this.trajectoryPositions.currentPoint, expandedRect)) {
        this.callCallback(elementData, { kind: "mouse", subType: "hover" })
        return
      }
    } else if (
      lineSegmentIntersectsRect(
        this.trajectoryPositions.currentPoint,
        this.trajectoryPositions.predictedPoint,
        expandedRect
      )
    ) {
      this.callCallback(elementData, { kind: "mouse", subType: "trajectory" })
    }
  }

  private handleMouseMove = (e: MouseEvent) => {
    this.updatePointerState(e)

    this.elements.forEach(currentData => {
      if (!currentData.isIntersectingWithViewport) {
        return
      }

      this.handleCallbackInteraction(currentData)
    })

    this.emit({
      type: "mouseTrajectoryUpdate",
      predictionEnabled: this._globalSettings.enableMousePrediction,
      timestamp: Date.now(),
      trajectoryPositions: this.trajectoryPositions,
    })
  }

  /**
   * Detects when registered elements are removed from the DOM and automatically unregisters them to prevent stale references.
   *
   * @param mutationsList - Array of MutationRecord objects describing the DOM changes
   *
   */
  private handleDomMutations = (mutationsList: MutationRecord[]) => {
    // Invalidate tabbale elements cache
    if (mutationsList.length) {
      this.tabbableElementsCache = []
      this.lastFocusedIndex = null
    }
    for (const mutation of mutationsList) {
      if (mutation.type === "childList" && mutation.removedNodes.length > 0) {
        for (const element of Array.from(this.elements.keys())) {
          if (!element.isConnected) {
            this.unregister(element, "disconnected")
          }
        }
      }
    }
  }

  // We store the last key for the FocusIn event, meaning we know if the user is tabbing around the page.
  // We dont use handleKeyDown for the full event because of 2 main reasons:
  // 1: handleKeyDown e.target returns the target on which the keydown is pressed (meaning we dont know which target got the focus)
  // 2: handleKeyUp does return the correct e.target however when holding tab the event doesnt repeat (handleKeyDown does)
  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      this.lastKeyDown = e
    }
  }

  private handleFocusIn = (e: FocusEvent) => {
    if (!this.lastKeyDown || !this._globalSettings.enableTabPrediction) {
      return
    }
    const targetElement = e.target
    if (!(targetElement instanceof HTMLElement)) {
      return
    }

    // tabbable uses element.GetBoundingClientRect under the hood, to avoid alot of computations we cache its values
    if (!this.tabbableElementsCache.length) {
      this.tabbableElementsCache = tabbable(document.documentElement)
    }

    // Determine the range of elements to check based on the tab direction and offset
    const isReversed = this.lastKeyDown.shiftKey

    const currentIndex: number = getFocusedElementIndex(
      isReversed,
      this.lastFocusedIndex,
      this.tabbableElementsCache,
      targetElement
    )

    this.lastFocusedIndex = currentIndex

    this.lastKeyDown = null
    const elementsToPredict: ForesightElement[] = []
    for (let i = 0; i <= this._globalSettings.tabOffset; i++) {
      if (isReversed) {
        const element = this.tabbableElementsCache[currentIndex - i]
        if (this.elements.has(element as ForesightElement)) {
          elementsToPredict.push(element as ForesightElement)
        }
      } else {
        const element = this.tabbableElementsCache[currentIndex + i]
        if (this.elements.has(element as ForesightElement)) {
          elementsToPredict.push(element as ForesightElement)
        }
      }
    }

    elementsToPredict.forEach(element => {
      this.callCallback(this.elements.get(element), {
        kind: "tab",
        subType: isReversed ? "reverse" : "forwards",
      })
    })
  }

  private updateHitCounters(elementData: ForesightElementData, hitType: HitType) {
    switch (hitType.kind) {
      case "mouse":
        elementData.callbackHits.mouse[hitType.subType]++
        this._globalCallbackHits.mouse[hitType.subType]++
        break
      case "tab":
        elementData.callbackHits.tab[hitType.subType]++
        this._globalCallbackHits.tab[hitType.subType]++
        break
      case "scroll":
        elementData.callbackHits.scroll[hitType.subType]++
        this._globalCallbackHits.scroll[hitType.subType]++
        break
    }
    elementData.callbackHits.total++
    this._globalCallbackHits.total++
  }

  private callCallback(elementData: ForesightElementData | undefined, hitType: HitType) {
    if (elementData) {
      this.updateHitCounters(elementData, hitType)
      elementData.callback()
      this._globalSettings.onAnyCallbackFired(elementData, this.getManagerData)

      this.emit({
        type: "callbackFired",
        timestamp: Date.now(),
        elementData: elementData,
        hitType: hitType,
      })

      this.unregister(elementData.element, "callbackHit")
    }
  }

  /**
   * ONLY use this function when you want to change the rect bounds via code, if the rects are changing because of updates in the DOM do not use this function.
   * We need an observer for that
   */
  private forceUpdateElementBounds(elementData: ForesightElementData) {
    const newOriginalRect = elementData.element.getBoundingClientRect()
    const expandedRect = getExpandedRect(newOriginalRect, elementData.elementBounds.hitSlop)

    if (!areRectsEqual(expandedRect, elementData.elementBounds.expandedRect)) {
      const updatedElementData = {
        ...elementData,
        elementBounds: {
          ...elementData.elementBounds,
          originalRect: newOriginalRect,
          expandedRect,
        },
      }
      this.elements.set(elementData.element, updatedElementData)

      this.emit({
        type: "elementDataUpdated",
        timestamp: Date.now(),
        elementData: updatedElementData,
        updatedProp: "bounds",
      })
    }
  }

  private updateElementBounds(newRect: DOMRect, elementData: ForesightElementData) {
    const updatedElementData = {
      ...elementData,
      elementBounds: {
        ...elementData.elementBounds,
        originalRect: newRect,
        expandedRect: getExpandedRect(newRect, elementData.elementBounds.hitSlop),
      },
    }
    this.elements.set(elementData.element, updatedElementData)

    this.emit({
      type: "elementDataUpdated",
      timestamp: Date.now(),
      elementData: updatedElementData,
      updatedProp: "bounds",
    })
  }

  private handleScrollPrefetch(elementData: ForesightElementData, newRect: DOMRect) {
    if (this._globalSettings.enableScrollPrediction) {
      // This means the foresightmanager is initializing registered elements, we dont want to calc the scroll direction here
      if (!elementData.elementBounds.originalRect) {
        return
      }
      // ONCE per animation frame we decide what the scroll direction is
      this.scrollDirection =
        this.scrollDirection ?? getScrollDirection(elementData.elementBounds.originalRect, newRect)
      if (this.scrollDirection === "none") {
        return
      }

      // ONCE per animation frame we decide the predicted scroll point
      this.predictedScrollPoint =
        this.predictedScrollPoint ??
        predictNextScrollPosition(
          this.trajectoryPositions.currentPoint,
          this.scrollDirection,
          this._globalSettings.scrollMargin
        )

      if (
        lineSegmentIntersectsRect(
          this.trajectoryPositions.currentPoint,
          this.predictedScrollPoint,
          elementData?.elementBounds.expandedRect
        )
      ) {
        this.callCallback(elementData, {
          kind: "scroll",
          subType: this.scrollDirection,
        })
      }
      this.emit({
        type: "scrollTrajectoryUpdate",
        timestamp: Date.now(),
        currentPoint: this.trajectoryPositions.currentPoint,
        predictedPoint: this.predictedScrollPoint,
      })
    } else {
      if (
        isPointInRectangle(
          this.trajectoryPositions.currentPoint,
          elementData.elementBounds.expandedRect
        )
      ) {
        this.callCallback(elementData, {
          kind: "mouse",
          subType: "hover",
        })
      }
    }
  }

  private handlePositionChange = (entries: PositionObserverEntry[]) => {
    for (const entry of entries) {
      const elementData = this.elements.get(entry.target)
      if (!elementData) continue
      const wasPreviouslyIntersecting = elementData.isIntersectingWithViewport
      const isNowIntersecting = entry.isIntersecting
      elementData.isIntersectingWithViewport = isNowIntersecting

      if (wasPreviouslyIntersecting !== isNowIntersecting) {
        // TODO check if visibility status is changing
        this.emit({
          type: "elementDataUpdated",
          elementData,
          timestamp: Date.now(),
          updatedProp: "visibility",
        })
      }
      if (isNowIntersecting) {
        this.updateElementBounds(entry.boundingClientRect, elementData)
        this.handleScrollPrefetch(elementData, entry.boundingClientRect)
      }
    }

    this.scrollDirection = null
    this.predictedScrollPoint = null
  }

  private initializeGlobalListeners() {
    if (this.isSetup) {
      return
    }
    // To avoid setting up listeners while ssr
    if (typeof window === "undefined" || typeof document === "undefined") {
      return
    }

    this.globalListenersController = new AbortController()
    const { signal } = this.globalListenersController
    document.addEventListener("mousemove", this.handleMouseMove) // Dont add signal we still need to emit events even without elements
    document.addEventListener("keydown", this.handleKeyDown, { signal })
    document.addEventListener("focusin", this.handleFocusIn, { signal })

    //Mutation observer is to automatically unregister elements when they leave the DOM. Its a fail-safe for if the user forgets to do it.
    this.domObserver = new MutationObserver(this.handleDomMutations)
    this.domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false,
    })

    // Handles all position based changes and update the rects of the elements. completely async to avoid dirtying the main thread.
    // Handles resize of elements
    // Handles resize of viewport
    // Handles scrolling
    this.positionObserver = new PositionObserver(this.handlePositionChange)

    this.isSetup = true
  }

  private removeGlobalListeners() {
    this.isSetup = false

    this.globalListenersController?.abort() // Remove all event listeners only in non debug mode
    this.globalListenersController = null

    this.domObserver?.disconnect()
    this.domObserver = null
    this.positionObserver?.disconnect()
    this.positionObserver = null
  }
}
