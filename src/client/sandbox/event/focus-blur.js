import SandboxBase from '../base';
import ActiveWindowTracker from '../event/active-window-tracker';
import nativeMethods from '../native-methods';
import * as browserUtils from '../../utils/browser';
import * as domUtils from '../../utils/dom';
import { getElementScroll, setScrollLeft, setScrollTop } from '../../utils/style';
import { HOVER_PSEUDO_CLASS_ATTR } from '../../../const';
import { isSVGElement } from '../../utils/types';

const INTERNAL_FOCUS_FLAG = 'hammerhead|internal-focus';
const INTERNAL_BLUR_FLAG  = 'hammerhead|internal-blur';

export default class FocusBlurSandbox extends SandboxBase {
    constructor (sandbox, eventSimulator) {
        super(sandbox);

        this.shouldDisableOuterFocusHandlers = false;
        this.topWindow                       = null;
        this.hoverElementFixed               = false;
        this.lastHoveredElement              = null;

        this.eventSimulator      = eventSimulator;
        this.activeWindowTracker = new ActiveWindowTracker(sandbox);
    }

    static _getNativeMeth (el, event) {
        if (isSVGElement(el)) {
            if (event === 'focus')
                return nativeMethods.svgFocus;
            else if (event === 'blur')
                return nativeMethods.svgBlur;
        }

        return nativeMethods[event];
    }

    _onMouseOverHandler (e) {
        if (this.hoverElementFixed || domUtils.isShadowUIElement(e.target))
            return;

        // NOTE: In this method, we are looking for a joint parent for the previous and the new hovered element.
        // Processes need only to that parent. This we are trying to reduce the number of dom calls.
        var clearHoverMarkerUntilJointParent = (newHoveredElement) => {
            var jointParent = null;

            if (this.lastHoveredElement) {
                var el = this.lastHoveredElement;

                while (el && el.tagName) {
                    // Check that the current element is a joint parent for the hovered elements.
                    if (el.contains && !el.contains(newHoveredElement)) {
                        nativeMethods.removeAttribute.call(el, HOVER_PSEUDO_CLASS_ATTR);
                        el = el.parentNode;
                    }
                    else
                        break;
                }

                jointParent = el;

                if (jointParent)
                    nativeMethods.removeAttribute.call(jointParent, HOVER_PSEUDO_CLASS_ATTR);
            }

            return jointParent;
        };

        var setHoverMarker = (newHoveredElement, jointParent) => {
            if (jointParent)
                nativeMethods.setAttribute.call(jointParent, HOVER_PSEUDO_CLASS_ATTR, '');

            while (newHoveredElement && newHoveredElement.tagName) {
                // Assign pseudo-class marker up to joint parent.
                if (newHoveredElement !== jointParent) {
                    nativeMethods.setAttribute.call(newHoveredElement, HOVER_PSEUDO_CLASS_ATTR, '');
                    newHoveredElement = newHoveredElement.parentNode;
                }
                else
                    break;
            }
        };

        var jointParent = clearHoverMarkerUntilJointParent(e.target);

        setHoverMarker(e.target, jointParent);
    }

    _onMouseOut (e) {
        if (!domUtils.isShadowUIElement(e.target))
            this.lastHoveredElement = e.target;
    }

    _callFocusCallback (callback, el) {
        //NOTE:in MSEdge event 'selectionchange' doesn't occur immediately (with some delay)
        //so we should raise it right after 'focus' event
        if (browserUtils.isIE && browserUtils.version > 11 && el && domUtils.isTextEditableElement(el))
            this.eventSimulator.selectionchange(el);

        if (typeof callback === 'function')
            callback();
    }

    _raiseEvent (el, type, callback, withoutHandlers, isAsync, forMouseEvent, preventScrolling) {
        //NOTE: focus and blur events should be raised after the activeElement changed (B237489)
        //in MSEdge focus/blur is sync
        var simulateEvent = () => {
            if (browserUtils.isIE && browserUtils.version < 12) {
                this.window.setTimeout(() => {
                    this.window.setTimeout(() => {
                        if (el[FocusBlurSandbox.getInternalEventFlag(type)])
                            delete el[FocusBlurSandbox.getInternalEventFlag(type)];
                    }, 0);
                }, 0);
            }
            else if (el[FocusBlurSandbox.getInternalEventFlag(type)])
                delete el[FocusBlurSandbox.getInternalEventFlag(type)];

            if (!withoutHandlers) {
                if (isAsync)
                    this.sandbox.event.timers.deferFunction(() => this.eventSimulator[type](el));
                else
                    this.eventSimulator[type](el);
            }

            callback();
        };

        //T239149 - TD15.1? - Error occurs during assertion creation on http://knockoutjs.com/examples/helloWorld.html in IE9
        if (browserUtils.isIE9 && this.sandbox.shadowUI.getRoot() === el && (type === 'focus' || type === 'blur'))
            callback();

        if (el[type]) {
            //NOTE: we should guarantee that activeElement will be changed, therefore we should call native focus/blur
            // event. To guarantee all focus/blur events raising we should raise it manually too.

            var windowScroll = null;

            if (preventScrolling)
                windowScroll = getElementScroll(this.window);

            var tempElement = null;

            if (type === 'focus' && el.tagName && el.tagName.toLowerCase() === 'label' &&
                el.htmlFor) {
                tempElement = domUtils.findDocument(el).getElementById(el.htmlFor);
                if (tempElement)
                    el = tempElement;
                else {
                    callback();
                    return;
                }
            }

            el[FocusBlurSandbox.getInternalEventFlag(type)] = true;

            FocusBlurSandbox._getNativeMeth(el, type).call(el);

            if (preventScrolling) {
                var newWindowScroll = getElementScroll(this.window);

                if (newWindowScroll.left !== windowScroll.left)
                    setScrollLeft(this.window, windowScroll.left);

                if (newWindowScroll.top !== windowScroll.top)
                    setScrollTop(this.window, windowScroll.top);
            }

            var curDocument   = domUtils.findDocument(el);
            var activeElement = domUtils.getActiveElement(curDocument);

            //if element was not focused and it has parent with tabindex, we focus this parent
            var parent             = el.parentNode;
            var parentWithTabIndex = domUtils.closest(parent, '[tabindex]');

            if (type === 'focus' && activeElement !== el && parent !== document &&
                parentWithTabIndex && forMouseEvent) {
                //NOTE: in WebKit,Safari and MS Edge calling of native focus for parent element raised page scrolling, we can't prevent it,
                // therefore we need to restore page scrolling value
                var needPreventScrolling = forMouseEvent &&
                                           (browserUtils.isWebKit || browserUtils.isSafari || browserUtils.isMSEdge);

                this._raiseEvent(parentWithTabIndex, 'focus', simulateEvent, false, false, forMouseEvent, needPreventScrolling);
            }
            // NOTE: some browsers doesn't change document.activeElement after element.blur() if browser window is on background.
            // That's why we call body.focus() without handlers. It should be called synchronously because client scripts may
            // expect that document.activeElement will be changed immediately after element.blur() calling.
            else if (type === 'blur' && activeElement === el && el !== curDocument.body)
                this._raiseEvent(curDocument.body, 'focus', simulateEvent, true);
            else
                simulateEvent();
        }
        else
            simulateEvent();
    }

    static getInternalEventFlag (type) {
        return type === 'focus' ? INTERNAL_FOCUS_FLAG : INTERNAL_BLUR_FLAG;
    }

    attach (window) {
        super.attach(window);

        this.activeWindowTracker.attach(window);
        this.topWindow = domUtils.isCrossDomainWindows(window, window.top) ? window : window.top;

        this.sandbox.event.listeners.addInternalEventListener(window, ['mouseover'], e => this._onMouseOverHandler(e));
        this.sandbox.event.listeners.addInternalEventListener(window, ['mouseout'], e => this._onMouseOut(e));
    }

    focus (el, callback, silent, forMouseEvent, isNativeFocus) {
        if (this.shouldDisableOuterFocusHandlers && !domUtils.isShadowUIElement(el))
            return null;

        var isElementInIFrame = domUtils.isElementInIframe(el);
        var iFrameElement     = isElementInIFrame ? domUtils.getIFrameByElement(el) : null;
        var curDocument       = domUtils.findDocument(el);
        var isBodyElement     = el === curDocument.body;

        var activeElement         = domUtils.getActiveElement();
        var activeElementDocument = domUtils.findDocument(activeElement);

        var withoutHandlers = false;
        var needBlur        = false;
        var needBlurIFrame  = false;

        var isContentEditable     = domUtils.isContentEditableElement(el);
        var isCurrentWindowActive = this.activeWindowTracker.isCurrentWindowActive();

        if (activeElement === el)
            withoutHandlers = !(isBodyElement && isContentEditable && !isCurrentWindowActive);
        else
            withoutHandlers = isBodyElement && !(isContentEditable || browserUtils.isIE);

        // NOTE: in IE if you call focus() or blur() methods from script, active element is changed immediately
        // but events are raised asynchronously after some timeout
        var isAsync = false;

        var raiseFocusEvent = () => {
            if (!isCurrentWindowActive && !domUtils.isShadowUIElement(el))
                this.activeWindowTracker.makeCurrentWindowActive();

            this._raiseEvent(el, 'focus', () => {
                if (!silent)
                    this.sandbox.event.elementEditingWatcher.watchElementEditing(el);

                // NOTE: If we call focus for unfocusable element (like 'div' or 'image') in iframe we should make
                // document.active this iframe manually, so we call focus without handlers
                if (isElementInIFrame && iFrameElement && this.topWindow.document.activeElement !== iFrameElement)
                    this._raiseEvent(iFrameElement, 'focus', () => this._callFocusCallback(callback, el), true, isAsync);
                else
                    this._callFocusCallback(callback, el);

            }, withoutHandlers || silent, isAsync, forMouseEvent);
        };

        if (isNativeFocus && browserUtils.isIE) {
            //in IE focus() method does not have any effect if it is called from focus event handler on second event phase
            if ((this.eventSimulator.isSavedWindowsEventsExists() || browserUtils.isIE && browserUtils.version > 10) &&
                this.window.event &&
                this.window.event.type === 'focus' && this.window.event.srcElement === el) {
                this._callFocusCallback(callback);

                return null;
            }

            if (browserUtils.version < 12) //in MSEdge focus/blur is sync
                isAsync = true;
        }

        if (activeElement && activeElement.tagName) {
            if (activeElement !== el) {
                if (curDocument !== activeElementDocument && activeElement === activeElementDocument.body)  //B253685
                    needBlur = false;
                else if (activeElement === curDocument.body) {
                    //Blur event raised for body only in IE. In addition, we must not call blur function for body because
                    //this leads to browser window moving to background
                    if (!silent && browserUtils.isIE) {
                        var simulateBodyBlur = this.eventSimulator.blur.bind(this.eventSimulator, activeElement);

                        if (isAsync)
                            this.sandbox.event.timers.internalSetTimeout.call(this.window, simulateBodyBlur, 0);
                        else
                            simulateBodyBlur();
                    }
                }
                else
                    needBlur = true;
            }

            //B254260
            needBlurIFrame = curDocument !== activeElementDocument &&
                             domUtils.isElementInIframe(activeElement, activeElementDocument);
        }
        //NOTE: we always call blur for iframe manually without handlers (B254260)
        if (needBlurIFrame && !needBlur) {
            if (browserUtils.isIE) {
                //NOTE: We should call blur for iframe with handlers in IE
                //but we can't call method 'blur' because activeElement !== element and handlers will not be called
                this.eventSimulator.blur(domUtils.getIFrameByElement(activeElement));
                raiseFocusEvent();
            }
            else
                this.blur(domUtils.getIFrameByElement(activeElement), raiseFocusEvent, true, isNativeFocus);
        }
        else if (needBlur) {
            this.blur(activeElement, function () {
                if (needBlurIFrame)
                    this.blur(domUtils.getIFrameByElement(activeElement), raiseFocusEvent, true, isNativeFocus);
                else
                    raiseFocusEvent();
            }, silent, isNativeFocus);
        }
        else
            raiseFocusEvent();
    }

    disableOuterFocusHandlers () {
        this.shouldDisableOuterFocusHandlers = true;
    }

    enableOuterFocusHandlers () {
        this.shouldDisableOuterFocusHandlers = false;
    }

    fixHoveredElement () {
        this.hoverElementFixed = true;
    }

    freeHoveredElement () {
        this.hoverElementFixed = false;
    }

    blur (el, callback, withoutHandlers, isNativeBlur) {
        var activeElement = domUtils.getActiveElement(domUtils.findDocument(el));
        //in IE if you call focus() or blur() methods from script, active element is changed immediately
        // but events are raised asynchronously after some timeout (in MSEdge focus/blur is sync)
        var isAsync = isNativeBlur && browserUtils.isIE && browserUtils.version < 12;

        if (activeElement !== el)
            withoutHandlers = true;

        if (!withoutHandlers) {
            this.sandbox.event.elementEditingWatcher.processElementChanging(el);
            this.sandbox.event.elementEditingWatcher.stopWatching(el);
        }

        this._raiseEvent(el, 'blur', function () {
            if (typeof callback === 'function')
                callback();
        }, withoutHandlers, isAsync);
    }
}