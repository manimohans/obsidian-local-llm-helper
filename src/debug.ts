let debugLoggingEnabled = false;

export function setDebugLogging(enabled: boolean): void {
	debugLoggingEnabled = enabled;
}

/**
 * Console logging gated behind the "Show agent debug" setting, so routine
 * operation doesn't spam the developer console. Errors and warnings should
 * still use console.error / console.warn directly.
 */
export function debugLog(...args: unknown[]): void {
	if (debugLoggingEnabled) {
		console.log(...args);
	}
}
