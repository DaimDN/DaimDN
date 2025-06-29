// MCP Protocol Error Classes
class MCPError extends Error {
	constructor(code, message, data = null) {
		super(message);
		this.name = "MCPError";
		this.code = code;
		this.data = data;
	}
}

const ErrorCodes = {
	// Parse errors
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,

	// Custom application errors
	BROWSER_ERROR: -32001,
	TOOL_EXECUTION_ERROR: -32002,
	AI_ERROR: -32003,
	ELEMENT_NOT_FOUND: -32004,
	NAVIGATION_ERROR: -32005,
	TIMEOUT_ERROR: -32006,
};

module.exports = { MCPError, ErrorCodes };
