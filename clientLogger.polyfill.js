var ClientLogger = (function (exports) {
    'use strict';

    var LogLevel;
    (function (LogLevel) {
        LogLevel["error"] = "error";
        LogLevel["warn"] = "warn";
        LogLevel["log"] = "log";
        LogLevel["debug"] = "debug";
        LogLevel["info"] = "info";
        LogLevel["trace"] = "trace";
    })(LogLevel || (LogLevel = {}));

    var ConfigValidator = /** @class */ (function () {
        function ConfigValidator() {
            this.validateConfiguration = function validateConfiguration(endpointUrl, options, promise) {
                if (options === void 0) { options = {}; }
                if (!endpointUrl) {
                    throw new Error("ClientLogger: No endpoint url defined.");
                    return null;
                }
                if (!promise) {
                    throw new Error("ClientLogger: You need a Promise polyfill to use this library in this browser" +
                        " or use https://polyfill.io/v2/");
                    return null;
                }
                options = options || {};
                var appliedOptions = {
                    endpointUrl: endpointUrl,
                    logUnhandledRejections: options.logUnhandledRejections || true,
                    debugLibrary: options.debugLibrary || false,
                    mockEndpoint: options.mockEndpoint || false,
                    updateAdditionalAppInfo: options.updateAdditionalAppInfo || (function (obj) { return obj; }),
                    actionTracking: options.actionTracking || {
                        changeEvents: true,
                        clickEvents: true,
                        networkEvents: true,
                        stackSize: 20,
                        enabled: true
                    },
                    logGlobalErrors: options.logGlobalErrors || true,
                    consoleLevelSettings: options.consoleLevelSettings || [
                        { logLevel: LogLevel.error, logToServer: true, hide: false }
                    ],
                    httpErrorsToLog: options.httpErrorsToLog || [{ logLevel: LogLevel.error, startsWith: "5" }],
                    additionalAppInfo: options.additionalAppInfo || {},
                    waitToResendTimeoutId: -1,
                    logScriptErrorOfOtherDomain: options.logScriptErrorOfOtherDomain || true
                };
                return appliedOptions;
            };
        }
        return ConfigValidator;
    }());

    var HttpInterceptor = /** @class */ (function () {
        function HttpInterceptor(globalWindow, interceptorConfig) {
            this.initXMLHttpInterceptor = function () {
                var that = this;
                var sendx = this.globalWindow.XMLHttpRequest.prototype.send;
                this.globalWindow.XMLHttpRequest.prototype.send = function () {
                    var args = [];
                    for (var _i = 0; _i < arguments.length; _i++) {
                        args[_i] = arguments[_i];
                    }
                    handleAsync(this);
                    return sendx.apply(this, arguments);
                };
                var openx = this.globalWindow.XMLHttpRequest.prototype.open;
                this.globalWindow.XMLHttpRequest.prototype.open = function (method, url) {
                    this._url = url;
                    this._method = method;
                    this._isClientLoggerCall = url.startsWith(that.interceptorConfig.endpointUrl);
                    return openx.apply(this, arguments);
                };
                function handleAsync(obj) {
                    var onerrorx = obj.onerror;
                    obj.onerror = onerror;
                    var onabortx = obj.onabort;
                    obj.onabort = onabort;
                    var onloadx = obj.onload;
                    obj.onload = onload;
                    function onerror(error) {
                        that.handleError(obj._url, obj._method, navigator.onLine, obj._isClientLoggerCall);
                        if (onerrorx) {
                            return onerrorx.apply(this, error);
                        }
                    }
                    function onabort(error) {
                        that.interceptorConfig.sendLogToServer.call(this, "error", "XMLHttpRequest to " + obj._url + " aborted.", {
                            status: "error",
                            url: obj._url,
                            method: obj._method
                        });
                        that.tryAddToUserActionStack("ONABORT", obj._url, obj._method);
                        if (onabortx) {
                            return onabortx.apply(this, error);
                        }
                    }
                    function onload(event) {
                        var request = event.target;
                        if (!this._isClientLoggerCall) {
                            that.tryAddToUserActionStack(request.status, obj._url, obj._method);
                            that.handleHttpResponse(request, obj);
                        }
                        if (onloadx) {
                            return onloadx.apply(this, arguments);
                        }
                    }
                }
            };
            this.handleError = function (url, method, navigatorIsOnline, isClientLoggerCall) {
                var msg = navigatorIsOnline ? "" : " probably no internet connection. detected with navigator.onLine";
                if (url && !isClientLoggerCall) {
                    var urlWithoutParams = method + "=" + url.split("?")[0].split("#")[0];
                    var errorObj = {
                        status: "error",
                        url: url,
                        method: method
                    };
                    if (this.interceptorConfig.lastUrl !== urlWithoutParams) {
                        var level = navigatorIsOnline ? "error" : "info";
                        this.interceptorConfig.lastUrl = urlWithoutParams;
                        this.interceptorConfig.sendLogToServer.call(this, level, "XMLHttpRequest to " + url + " failed." + msg, errorObj);
                    }
                    else {
                        this.interceptorConfig.internalLog("skip (duplicate) sending error for url " + urlWithoutParams, errorObj);
                    }
                    this.tryAddToUserActionStack("ONERROR", url, method);
                }
            };
            this.tryAddToUserActionStack = function (status, url, method) {
                if (this.interceptorConfig.trackNetworkEvents) {
                    var info = {
                        event: "network",
                        target: url,
                        info: "StatusCode=" + status + " HttpMethod=" + method
                    };
                    this.interceptorConfig.internalLog("got network event", info);
                    this.interceptorConfig.addToUserActionStack(info);
                }
            };
            this.handleHttpResponse = function (request, obj) {
                if (!this.interceptorConfig.handleHttpErrors) {
                    return;
                }
                var statusCodeMatch = this.interceptorConfig.handleHttpErrors.find(function (x) {
                    return (request.status + "").startsWith(x.startsWith);
                });
                if (!statusCodeMatch) {
                    return;
                }
                var details = {
                    status: request.status,
                    url: obj._url,
                    method: obj._method
                };
                this.interceptorConfig.sendLogToServer(statusCodeMatch.logLevel, "XMLHttpRequest to " + obj._url + " resulted with status code: " + request.status, details);
            };
            this.globalWindow = globalWindow;
            this.interceptorConfig = interceptorConfig;
            this.initXMLHttpInterceptor();
        }
        return HttpInterceptor;
    }());

    var LogsSender = /** @class */ (function () {
        function LogsSender(senderConfig, internalLog, isOnlineFn) {
            this.globalWindow = window;
            this.failedTransmissions = [];
            this.secondsToWait = 20;
            this.waitToResendTimeoutId = -1;
            this.sendLogFn = function (url, body) {
                var _this = this;
                return new this.globalWindow.Promise(function (reslove) {
                    _this.internalLog("%cFake sending log to: " + url, "color: green;", body);
                    reslove();
                });
            };
            this.sendFailed = function sendFailed(log) {
                var _this = this;
                this.failedTransmissions.push(log);
                // wait some time before resending
                if (this.waitToResendTimeoutId == -1) {
                    this.internalLog("waiting " + this.secondsToWait + " seconds before try to resend.");
                    this.waitToResendTimeoutId = setTimeout(function () { return _this.tryResendFailedTransmissions(); }, this.secondsToWait * 1000);
                }
            };
            this.resendLog = function resendLog(log) {
                var _this = this;
                if (!this.isApplicationOnlineFn()) {
                    this.internalLog("%cClientLogger: Sending Log posponed since navigator in not onLine");
                    this.sendFailed(log);
                    return this.globalWindow.Promise.resolve(false);
                }
                var url = this.senderConfig.endpointUrl;
                if (this.senderConfig.endpointUrl.endsWith('/')) {
                    url += log.level;
                } else {
                    url += "/" + log.level;
                }
                return this.sendLogFn(url, log)
                    .then(function () {
                    _this.internalLog("ClientLogger sending Log OK");
                    return true;
                })["catch"](function (err) {
                    _this.internalLog("%cClientLogger: Sending Log failed. ErrorMsg: " + err, "color: red; font-size:15px;");
                    _this.sendFailed(log);
                    return false;
                });
            };
            this.tryResendFailedTransmissions = function () {
                var _this = this;
                this.waitToResendTimeoutId = -1;
                var msg = this.failedTransmissions.pop();
                if (msg == null) {
                    return;
                }
                this.resendLog(msg).then(function (resendSuccess) {
                    if (resendSuccess) {
                        _this.tryResendFailedTransmissions();
                    }
                });
            };
            this.sendLogToServer = function sendLogToServer(level, message, details, userActionStack) {
                var additionalAppInfo = Object.assign({}, this.senderConfig.additionalAppInfo);
                if (this.senderConfig.updateAdditionalAppInfo) {
                    additionalAppInfo = this.senderConfig.updateAdditionalAppInfo(additionalAppInfo);
                }

                if (typeof(details) === "string") {
                    details = { detailMsg: details };
                }

                var browserInfo = {
                    appName: navigator.appName,
                    appVersion: navigator.appVersion,
                    userAgent: navigator.userAgent,
                    language: navigator.language,
                    navigatorOnLine: this.isApplicationOnlineFn()
                };
                var log = {
                    message: message,
                    details: details,
                    browserInfo: browserInfo,
                    additionalAppInfo: additionalAppInfo,
                    timestamp: new Date(),
                    userActionStack: userActionStack,
                    level: level
                };
                return this.resendLog(log);
            };
            this.internalLog = internalLog;
            this.senderConfig = senderConfig;
            this.isApplicationOnlineFn = isOnlineFn;
            if (!this.senderConfig.mockEndpoint) {
                var that_1 = this;
                this.sendLogFn = function makeRequest(url, bodyContent, method) {
                    if (method === void 0) { method = "POST"; }
                    return new this.globalWindow.Promise(function (resolve, reject) {
                        var xhr = new that_1.globalWindow.XMLHttpRequest();
                        xhr.open(method, url);
                        xhr.setRequestHeader("Content-Type", "application/json");
                        xhr.onload = function () {
                            if (this.status >= 200 && this.status < 300) {
                                resolve(xhr.response);
                            }
                            else {
                                reject({
                                    status: this.status,
                                    statusText: xhr.statusText
                                });
                            }
                        };
                        xhr.onerror = function () {
                            reject({
                                status: this.status,
                                statusText: xhr.statusText
                            });
                        };
                        xhr.send(JSON.stringify(bodyContent));
                    });
                };
            }
        }
        return LogsSender;
    }());

    var UserActionStack = /** @class */ (function () {
        function UserActionStack(internalLog, actionTracking) {
            this.handleUserEvent = function (e) {
                var identifier = e.target.id || e.target.name;
                identifier = identifier || (e.target.textContent && e.target.textContent.substring(0, 30));
                var elementName = e.target.tagName + ":" + identifier;
                var info = { event: e.type, target: elementName };
                this.internalLog("got user event", info);
                this.addToUserActionStack(info);
            };
            this.userActionStack = [];
            this.initUserActionStack = function () {
                var _this = this;
                if (this.actionTracking.clickEvents) {
                    document.addEventListener("click", function (e) {
                        _this.handleUserEvent(e);
                    });
                }
                if (this.actionTracking.changeEvents) {
                    document.addEventListener("change", function (e) {
                        _this.handleUserEvent(e);
                    });
                }
            };
            this.addToUserActionStack = function addToUserActionStack(event) {
                this.userActionStack.unshift(event);
                if (this.userActionStack.length >= this.actionTracking.stackSize) {
                    this.userActionStack.pop();
                }
            };
            this.internalLog = internalLog;
            this.actionTracking = actionTracking;
            if (actionTracking.enabled) {
                this.initUserActionStack();
            }
        }
        UserActionStack.prototype.copyStack = function () {
            return Array.from(this.userActionStack);
        };
        return UserActionStack;
    }());

    var ClientLogger = /** @class */ (function () {
        function ClientLogger(endpointUrl, userOptions) {
            var _this = this;
            this.noopFn = function () {
                var passedArgs = [];
                for (var _i = 0; _i < arguments.length; _i++) {
                    passedArgs[_i] = arguments[_i];
                }
                return true;
            };
            this.internalLog = function () {
                var passedArgs = [];
                for (var _i = 0; _i < arguments.length; _i++) {
                    passedArgs[_i] = arguments[_i];
                }
                return true;
            };
            this.tryWriteToConsole = function (fn, argsToLog) {
                // try catch for ie11
                try {
                    fn.apply(null, argsToLog);
                    return true;
                }
                catch (e) {
                    window.logBucketIfNoConsole = window.logBucketIfNoConsole || [];
                    window.logBucketIfNoConsole.push({ e: e, arguments: argsToLog });
                }
                return false;
            };
            this.initConsoleTracking = function (logLevel, setting) {
                if (setting === void 0) { setting = { hide: false, logToServer: false, logLevel: logLevel }; }
                this.internalLog("initConsoleTracking for " + logLevel, setting);
                var loglevelFn = console[logLevel];
                var logToConsole = setting.hide ? this.noopFn : this.tryWriteToConsole;
                var that = this;
                if (setting.logToServer) {
                    console[logLevel] = function () {
                        var msgObj = arguments[0] || "ClientLogger: no " + logLevel + " msg.";
                        var msg = "";
                        if (typeof msgObj == "object") {
                            msg = msgObj.toString();
                            if (msgObj.stack) {
                                msg += " Stack: " + msgObj.stack;
                            }
                        }
                        else {
                            msg = msgObj.toString();
                        }
                        var passedArgs = [].slice.call(arguments);
                        var details = passedArgs.length > 1 ? passedArgs.slice(1, passedArgs.length) : "";
                        logToConsole(loglevelFn, arguments);
                        that.sendLogToServer(logLevel, msg, details);
                    };
                }
                else {
                    console[logLevel] = function () {
                        var args = [];
                        for (var _i = 0; _i < arguments.length; _i++) {
                            args[_i] = arguments[_i];
                        }
                        logToConsole(loglevelFn, args);
                    };
                }
            };
            this.onErrorHandler = function onErrorHandler(errorEvent, logScriptErrorOfOtherDomain) {
                var msg = "Got error: " + errorEvent.message + " on line\n      " + errorEvent.lineno + ", at char: " + errorEvent.colno + " in file: " + errorEvent.filename;
                var obj = {
                    message: errorEvent.message,
                    filename: errorEvent.filename,
                    lineno: errorEvent.lineno,
                    colno: errorEvent.colno,
                    stack: errorEvent.error && errorEvent.error.stack
                };
                this.internalLog(msg, obj);
                var isScriptFromOtherDomain = errorEvent.message == "Script error." && errorEvent.lineno == 0 && errorEvent.colno == 0;
                if (logScriptErrorOfOtherDomain && isScriptFromOtherDomain) {
                    this.sendLogToServer(LogLevel.error, msg, obj);
                }
                else {
                    this.internalLog("skipped send error because of logScriptErrorOfOtherDomain", obj);
                }
            };
            this.onUnhandledRejection = function (event) {
                var error = event ? event.reason : undefined;
                this.internalLog("onUnhandledRejection:Got error: " + error, event);
                this.sendLogToServer(LogLevel.error, error, event);
            };
            this.internalLog = this.noopFn;
            var globalWindow = window;
            globalWindow.logBucketIfNoConsole = globalWindow.logBucketIfNoConsole || [];
            this.noopFn = function () {
                var passedArgs = [];
                for (var _i = 0; _i < arguments.length; _i++) {
                    passedArgs[_i] = arguments[_i];
                }
                return false;
            };
            var validator = new ConfigValidator();
            var loggingConfig = validator.validateConfiguration(endpointUrl, userOptions, globalWindow.Promise);
            if (loggingConfig == null) {
                return;
            }
            var consoleLogFn = console.log;
            if (loggingConfig.debugLibrary) {
                this.internalLog = function () {
                    var passedArgs = [];
                    for (var _i = 0; _i < arguments.length; _i++) {
                        passedArgs[_i] = arguments[_i];
                    }
                    return _this.tryWriteToConsole(consoleLogFn, passedArgs);
                };
            }
            this.internalLog("start up with settings:", loggingConfig);
            var userActionStack = new UserActionStack(this.internalLog, loggingConfig.actionTracking);
            var logSender = new LogsSender(loggingConfig, this.internalLog, function () { return navigator.onLine; });
            this.sendLogToServer = function sendLogToServer(level, message, details) {
                return logSender.sendLogToServer(level, message, details, userActionStack.copyStack());
            };
            Object.keys(LogLevel).map(function (key) {
                return _this.initConsoleTracking(key, loggingConfig.consoleLevelSettings.find(function (x) { return x.logLevel == key; }));
            });
            if (loggingConfig.httpErrorsToLog.length) {
                var config = {
                    endpointUrl: loggingConfig.endpointUrl,
                    handleHttpErrors: loggingConfig.httpErrorsToLog,
                    trackNetworkEvents: loggingConfig.actionTracking.networkEvents,
                    sendLogToServer: this.sendLogToServer,
                    addToUserActionStack: function (e) {
                        userActionStack.addToUserActionStack(e);
                    },
                    internalLog: this.internalLog
                };
                this.httpInterceptor = new HttpInterceptor(globalWindow, config);
            }
            if (loggingConfig.logGlobalErrors) {
                window.addEventListener("error", function (e) {
                    _this.onErrorHandler(e, loggingConfig.logScriptErrorOfOtherDomain);
                });
            }
            // Listen to uncaught promises rejections
            if (loggingConfig.logUnhandledRejections) {
                window.addEventListener("unhandledrejection", function (e) {
                    _this.onUnhandledRejection(e);
                });
            }
        }
        return ClientLogger;
    }());

    function createLogger(url, options) {
        return new ClientLogger(url, options);
    }

    exports.createLogger = createLogger;

    return exports;

}({}));
