const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs").promises;
const WebSocket = require("ws");
const http = require("http");
const OpenAI = require("openai");

let PlaywrightMCPHandler;
let data = {};

try {
	data = require("./config/default.json");
} catch (error) {
	console.warn("Config file not found, using environment variables");
	data = {};
}

try {
	const handlers = require("./mcp/handlers");
	PlaywrightMCPHandler = handlers.PlaywrightMCPHandler;
} catch (error) {
	console.error("MCP handlers not found:", error.message);
	process.exit(1);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

let activeConnections = new Set();
let activeSessions = new Map();

class AIActionProcessor {
	constructor(apiKey) {
		this.openai = new OpenAI({ apiKey });
	}

	async processCommand(message, pageSnapshot, currentUrl) {
		const systemPrompt = `You are an AI assistant that converts natural language commands into specific web automation actions. 

Available actions:
- navigate: { action: "navigate", url: "string" }
- click: { action: "click", selector: "string", text: "optional description" }
- type: { action: "type", selector: "string", text: "string" }
- search: { action: "search", query: "string" }
- scroll: { action: "scroll", direction: "up|down|left|right" }
- wait: { action: "wait", selector: "string" }
- screenshot: { action: "screenshot" }
- press_key: { action: "press_key", key: "string" }
- generate_test: { action: "generate_test" }

Current page URL: ${currentUrl || "None"}
Available elements: ${
			pageSnapshot
				? JSON.stringify(pageSnapshot.elements?.slice(0, 10) || [])
				: "None"
		}

IMPORTANT: Always try to find exact selectors from the available elements list when possible.

Convert the user's command into a valid JSON action object. Always respond with valid JSON only.

Examples:
- "visit google.com" → {"action": "navigate", "url": "https://google.com"}
- "scroll down" → {"action": "scroll", "direction": "down"}
- "click search button" → {"action": "click", "selector": "button", "text": "search button"}
- "type hello" → {"action": "type", "selector": "input", "text": "hello"}
- "generate test cases" → {"action": "generate_test"}`;

		try {
			const response = await this.openai.chat.completions.create({
				model: "gpt-4o-mini",
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: message },
				],
				temperature: 0.1,
				max_tokens: 500,
			});

			const actionText = response.choices[0].message.content.trim();
			let actionObj;

			try {
				actionObj = JSON.parse(actionText);
			} catch (parseError) {
				const jsonMatch = actionText.match(/\{[^}]+\}/);
				if (jsonMatch) {
					actionObj = JSON.parse(jsonMatch[0]);
				} else {
					throw parseError;
				}
			}

			return this.validateAction(actionObj);
		} catch (error) {
			console.error("AI processing error:", error);
			return this.fallbackParser(message);
		}
	}

	validateAction(actionObj) {
		if (!actionObj || !actionObj.action) {
			throw new Error("Invalid action object");
		}

		const validActions = [
			"navigate",
			"click",
			"type",
			"search",
			"scroll",
			"wait",
			"screenshot",
			"press_key",
			"generate_test",
		];
		if (!validActions.includes(actionObj.action)) {
			throw new Error(`Invalid action: ${actionObj.action}`);
		}

		switch (actionObj.action) {
			case "navigate":
				if (!actionObj.url) {
					throw new Error("Navigate action requires url");
				}
				if (!actionObj.url.startsWith("http")) {
					actionObj.url = `https://${actionObj.url}`;
				}
				break;
			case "scroll":
				if (!actionObj.direction) {
					actionObj.direction = "down";
				}
				if (!["up", "down", "left", "right"].includes(actionObj.direction)) {
					actionObj.direction = "down";
				}
				break;
			case "click":
				if (!actionObj.selector) {
					actionObj.selector = 'button, a, [role="button"]';
				}
				break;
			case "type":
				if (!actionObj.selector) {
					actionObj.selector = "input, textarea";
				}
				if (!actionObj.text) {
					throw new Error("Type action requires text");
				}
				break;
			case "search":
				if (!actionObj.query) {
					throw new Error("Search action requires query");
				}
				break;
			case "wait":
				if (!actionObj.selector) {
					actionObj.selector = "*";
				}
				break;
			case "press_key":
				if (!actionObj.key) {
					actionObj.key = "Enter";
				}
				break;
		}

		return actionObj;
	}

	fallbackParser(message) {
		const lowerMessage = message.toLowerCase().trim();

		// Check for test generation commands
		if (
			lowerMessage.includes("generate test") ||
			lowerMessage.includes("create test") ||
			lowerMessage.includes("test case") ||
			lowerMessage.includes("test code")
		) {
			return { action: "generate_test" };
		}

		if (
			lowerMessage.includes("navigate") ||
			lowerMessage.includes("go to") ||
			lowerMessage.includes("open") ||
			lowerMessage.includes("visit")
		) {
			const patterns = [
				/(?:https?:\/\/)?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?)/,
				/(?:visit|go to|open|navigate to)\s+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
				/([a-zA-Z0-9.-]+\.(?:com|org|net|edu|gov|io|co))/i,
			];

			for (const pattern of patterns) {
				const urlMatch = message.match(pattern);
				if (urlMatch) {
					let url = urlMatch[1] || urlMatch[0];
					url = url.replace(/^(visit|go to|open|navigate to)\s+/i, "");
					if (!url.startsWith("http")) {
						url = `https://${url}`;
					}
					return { action: "navigate", url };
				}
			}
		}

		if (lowerMessage.includes("click")) {
			const textMatch = message.match(/click(?:\s+on)?\s+(.+)/i);
			const text = textMatch ? textMatch[1] : "clickable element";
			return { action: "click", selector: "button, a, [role='button']", text };
		}

		if (
			lowerMessage.includes("type") ||
			lowerMessage.includes("enter text") ||
			lowerMessage.includes("input")
		) {
			const textPatterns = [
				/type\s+"([^"]+)"/i,
				/type\s+'([^']+)'/i,
				/type\s+(.+)/i,
				/enter\s+text\s+"([^"]+)"/i,
				/enter\s+text\s+'([^']+)'/i,
				/enter\s+text\s+(.+)/i,
				/input\s+"([^"]+)"/i,
				/input\s+'([^']+)'/i,
				/input\s+(.+)/i,
			];

			for (const pattern of textPatterns) {
				const textMatch = message.match(pattern);
				if (textMatch) {
					const text = textMatch[1].trim();
					return { action: "type", selector: "input, textarea", text };
				}
			}
		}

		if (lowerMessage.includes("search")) {
			const searchPatterns = [
				/search\s+for\s+"([^"]+)"/i,
				/search\s+for\s+'([^']+)'/i,
				/search\s+for\s+(.+)/i,
				/search\s+"([^"]+)"/i,
				/search\s+'([^']+)'/i,
				/search\s+(.+)/i,
			];

			for (const pattern of searchPatterns) {
				const searchMatch = message.match(pattern);
				if (searchMatch) {
					const query = searchMatch[1].trim();
					return { action: "search", query };
				}
			}
		}

		if (lowerMessage.includes("scroll")) {
			const direction = lowerMessage.includes("up")
				? "up"
				: lowerMessage.includes("down")
				  ? "down"
				  : lowerMessage.includes("left")
				    ? "left"
				    : lowerMessage.includes("right")
				      ? "right"
				      : "down";
			return { action: "scroll", direction };
		}

		if (
			lowerMessage.includes("screenshot") ||
			lowerMessage.includes("capture") ||
			lowerMessage.includes("take picture")
		) {
			return { action: "screenshot" };
		}

		if (
			lowerMessage.includes("enter") ||
			lowerMessage.includes("press enter")
		) {
			return { action: "press_key", key: "Enter" };
		}

		if (lowerMessage.includes("wait")) {
			return { action: "wait", selector: "*" };
		}

		const urlPattern = /([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;
		const urlMatch = message.match(urlPattern);
		if (urlMatch) {
			let url = urlMatch[1];
			if (!url.startsWith("http")) {
				url = `https://${url}`;
			}
			return { action: "navigate", url };
		}

		return { action: "unknown", message, originalInput: message };
	}

	async findBestSelector(elements, actionType, description) {
		if (!elements || elements.length === 0) return null;

		// First try to find exact matches
		const exactMatch = this.findExactMatch(elements, actionType, description);
		if (exactMatch) return exactMatch;

		// Use AI for complex matching
		const prompt = `Given these page elements: ${JSON.stringify(
			elements.slice(0, 20),
		)}
        
Find the best CSS selector for action: ${actionType}
Description: ${description}

Return only the CSS selector string, nothing else.`;

		try {
			const response = await this.openai.chat.completions.create({
				model: "gpt-4o-mini",
				messages: [{ role: "user", content: prompt }],
				temperature: 0,
				max_tokens: 100,
			});

			return response.choices[0].message.content.trim().replace(/['"]/g, "");
		} catch (error) {
			console.error("Selector AI error:", error);
			return this.fallbackSelectorFinder(elements, actionType, description);
		}
	}

	findExactMatch(elements, actionType, description) {
		const lowerDesc = description.toLowerCase();

		if (actionType === "click") {
			// Look for buttons with specific text
			const button = elements.find(
				(el) =>
					(el.tag === "button" || el.tag === "a" || el.role === "button") &&
					el.text &&
					el.text.toLowerCase().includes(lowerDesc),
			);
			if (button) return button.selector;

			// Look for any clickable element
			const clickable = elements.find(
				(el) =>
					el.tag === "button" ||
					el.tag === "a" ||
					el.type === "submit" ||
					el.role === "button",
			);
			if (clickable) return clickable.selector;
		}

		if (actionType === "type") {
			// Look for input fields
			const input = elements.find(
				(el) =>
					(el.tag === "input" || el.tag === "textarea") &&
					(!el.type || el.type === "text" || el.type === "search"),
			);
			if (input) return input.selector;
		}

		return null;
	}

	fallbackSelectorFinder(elements, actionType, description) {
		const lowerDesc = description.toLowerCase();

		if (actionType === "click") {
			const clickable = elements.filter(
				(el) =>
					el.tag === "button" ||
					el.tag === "a" ||
					el.type === "submit" ||
					el.role === "button",
			);

			if (lowerDesc.includes("search")) {
				const searchBtn = clickable.find(
					(el) =>
						el.text?.toLowerCase().includes("search") ||
						el.value?.toLowerCase().includes("search"),
				);
				if (searchBtn) return searchBtn.selector;
			}

			return clickable[0]?.selector || "button";
		}

		if (actionType === "type") {
			const inputs = elements.filter(
				(el) =>
					el.tag === "input" || el.tag === "textarea" || el.type === "input",
			);

			if (lowerDesc.includes("search")) {
				const searchInput = inputs.find(
					(el) =>
						el.placeholder?.toLowerCase().includes("search") ||
						el.name?.toLowerCase().includes("search") ||
						el.id?.toLowerCase().includes("search"),
				);
				if (searchInput) return searchInput.selector;
			}

			return inputs[0]?.selector || "input";
		}

		return null;
	}
}

// WebSocket connection handling
wss.on("connection", (ws) => {
	const sessionId = Date.now().toString();
	activeConnections.add(ws);
	ws.sessionId = sessionId;

	try {
		const apiKey = process.env.OPENAI_API_KEY || data.openai_key || data.key;
		if (!apiKey) {
			ws.send(
				JSON.stringify({
					type: "error",
					message:
						"API key not configured. Please set OPENAI_API_KEY environment variable.",
				}),
			);
			ws.close();
			return;
		}

		activeSessions.set(sessionId, {
			ws,
			handler: new PlaywrightMCPHandler(apiKey),
			aiProcessor: new AIActionProcessor(apiKey),
			isActive: false,
			currentUrl: null,
			pageSnapshot: null,
			testSteps: [],
			lastAction: null,
		});

		ws.send(
			JSON.stringify({
				type: "session_started",
				sessionId,
				message:
					"AI-powered automation session started. Try commands like 'visit google.com', 'scroll down', 'click search button', etc.",
			}),
		);
	} catch (error) {
		ws.send(
			JSON.stringify({
				type: "error",
				message: `Session initialization failed: ${error.message}`,
			}),
		);
		ws.close();
		return;
	}

	ws.on("message", async (message) => {
		try {
			const parsedData = JSON.parse(message);
			await handleChatMessage(sessionId, parsedData);
		} catch (error) {
			console.error("Message handling error:", error);
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(
					JSON.stringify({
						type: "error",
						message: `Error processing message: ${error.message}`,
					}),
				);
			}
		}
	});

	ws.on("close", () => {
		cleanup(sessionId);
	});

	ws.on("error", (error) => {
		console.error("WebSocket error:", error);
		cleanup(sessionId);
	});
});

function cleanup(sessionId) {
	const session = activeSessions.get(sessionId);
	if (session) {
		activeConnections.delete(session.ws);
		try {
			if (session.handler && typeof session.handler.cleanup === "function") {
				session.handler.cleanup();
			}
		} catch (error) {
			console.error("Cleanup error:", error);
		}
		activeSessions.delete(sessionId);
	}
}

function safeWebSocketSend(ws, data) {
	if (ws && ws.readyState === WebSocket.OPEN) {
		try {
			ws.send(JSON.stringify(data));
		} catch (error) {
			console.error("WebSocket send error:", error);
		}
	}
}

async function handleChatMessage(sessionId, data) {
	const session = activeSessions.get(sessionId);
	if (!session || !session.ws) {
		console.error("Session not found:", sessionId);
		return;
	}

	const { message, type } = data;
	const ws = session.ws;

	if (!message || typeof message !== "string") {
		safeWebSocketSend(ws, {
			type: "error",
			message: "Invalid message format",
		});
		return;
	}

	safeWebSocketSend(ws, {
		type: "ai_processing",
		message: "🤖 AI analyzing your request...",
	});

	try {
		const actionCommand = await session.aiProcessor.processCommand(
			message,
			session.pageSnapshot,
			session.currentUrl,
		);

		if (actionCommand.action === "unknown") {
			safeWebSocketSend(ws, {
				type: "error",
				message: `❌ I couldn't understand: "${message}". Try commands like "visit google.com", "scroll down", "click button", "type hello", "generate test cases", etc.`,
			});
			return;
		}

		safeWebSocketSend(ws, {
			type: "ai_decision",
			action: actionCommand,
			message: `🎯 AI decided: ${actionCommand.action.toUpperCase()}`,
		});

		await executeAction(session, actionCommand, message);
	} catch (error) {
		console.error("Command handling error:", error);
		safeWebSocketSend(ws, {
			type: "error",
			message: `❌ Command failed: ${error.message}`,
		});
	}
}

async function executeAction(session, actionCommand, originalMessage) {
	const ws = session.ws;

	try {
		switch (actionCommand.action) {
			case "navigate":
				await handleNavigate(session, actionCommand);
				break;
			case "click":
				await handleClick(session, actionCommand);
				break;
			case "type":
				await handleType(session, actionCommand);
				break;
			case "search":
				await handleSearch(session, actionCommand);
				break;
			case "scroll":
				await handleScroll(session, actionCommand);
				break;
			case "wait":
				await handleWait(session, actionCommand);
				break;
			case "screenshot":
				await handleScreenshot(session);
				break;
			case "press_key":
				await handlePressKey(session, actionCommand);
				break;
			case "generate_test":
				await generateTest(session);
				break;
			default:
				safeWebSocketSend(ws, {
					type: "error",
					message: `❌ Unknown action: ${actionCommand.action}. Try commands like "visit google.com", "scroll down", "click button", etc.`,
				});
		}
	} catch (error) {
		console.error("Action execution error:", error);
		safeWebSocketSend(ws, {
			type: "error",
			message: `❌ Action failed: ${error.message}`,
		});
	}
}

async function handleNavigate(session, actionCommand) {
	const ws = session.ws;
	const url = actionCommand.url;

	try {
		if (!session.isActive) {
			safeWebSocketSend(ws, {
				type: "status",
				message: "🚀 Initializing browser...",
			});

			await session.handler.handleTool("browser_initialize", {}, (progress) => {
				safeWebSocketSend(ws, {
					type: "progress",
					...progress,
				});
			});

			session.isActive = true;
		}

		safeWebSocketSend(ws, {
			type: "action_start",
			action: "navigate",
			url: url,
			message: `🌐 Navigating to ${url}...`,
		});

		const result = await session.handler.handleTool(
			"page_navigate",
			{ url },
			(progress) => {
				safeWebSocketSend(ws, {
					type: "progress",
					...progress,
				});
			},
		);

		session.currentUrl = result.url;
		session.testSteps.push(`await page.goto('${url}');`);

		// Wait a bit for page to load
		await new Promise((resolve) => setTimeout(resolve, 2000));

		try {
			const snapshot = await session.handler.handleTool(
				"page_get_snapshot",
				{},
				() => {},
			);
			session.pageSnapshot = snapshot.snapshot;

			safeWebSocketSend(ws, {
				type: "navigation_complete",
				url: result.url,
				title: result.title || "Unknown Title",
				elements: snapshot.snapshot.elements || [],
				elementsCount: (snapshot.snapshot.elements || []).length,
				message: `✅ Successfully loaded ${result.title || url}`,
			});
		} catch (snapshotError) {
			console.error("Snapshot error:", snapshotError);
			safeWebSocketSend(ws, {
				type: "navigation_complete",
				url: result.url,
				title: result.title || "Unknown Title",
				elements: [],
				elementsCount: 0,
				message: `✅ Successfully loaded ${result.title || url}`,
			});
		}
	} catch (error) {
		console.error("Navigation error:", error);
		safeWebSocketSend(ws, {
			type: "error",
			message: `❌ Navigation failed: ${error.message}`,
		});
	}
}

async function handleClick(session, actionCommand) {
	const ws = session.ws;

	if (!session.isActive) {
		safeWebSocketSend(ws, {
			type: "error",
			message: "Please navigate to a website first",
		});
		return;
	}

	try {
		let selector = actionCommand.selector;

		// Try to find a better selector from available elements
		if (session.pageSnapshot && session.pageSnapshot.elements) {
			const bestSelector = await session.aiProcessor.findBestSelector(
				session.pageSnapshot.elements,
				"click",
				actionCommand.text || "clickable element",
			);
			if (bestSelector) {
				selector = bestSelector;
			}
		}

		safeWebSocketSend(ws, {
			type: "action_start",
			action: "click",
			selector: selector,
			message: `🎯 Clicking: ${selector}`,
		});

		// Use a more robust click approach
		const result = await session.handler.handleTool(
			"element_click",
			{ selector, timeout: 10000 },
			(progress) => {
				safeWebSocketSend(ws, {
					type: "progress",
					...progress,
				});
			},
		);

		session.testSteps.push(`await page.click('${selector}');`);

		// Wait for potential navigation or changes
		await new Promise((resolve) => setTimeout(resolve, 1000));

		try {
			const newSnapshot = await session.handler.handleTool(
				"page_get_snapshot",
				{},
				() => {},
			);
			session.pageSnapshot = newSnapshot.snapshot;

			safeWebSocketSend(ws, {
				type: "action_complete",
				action: "click",
				selector: selector,
				success: true,
				newElements: newSnapshot.snapshot.elements || [],
				message: `✅ Successfully clicked: ${selector}`,
			});
		} catch (snapshotError) {
			console.error("Post-click snapshot error:", snapshotError);
			safeWebSocketSend(ws, {
				type: "action_complete",
				action: "click",
				selector: selector,
				success: true,
				message: `✅ Successfully clicked: ${selector}`,
			});
		}
	} catch (error) {
		console.error("Click error:", error);
		safeWebSocketSend(ws, {
			type: "error",
			message: `❌ Click failed: ${error.message}`,
		});
	}
}

async function handleType(session, actionCommand) {
	const ws = session.ws;

	if (!session.isActive) {
		safeWebSocketSend(ws, {
			type: "error",
			message: "Please navigate to a website first",
		});
		return;
	}

	try {
		let selector = actionCommand.selector;
		const text = actionCommand.text;

		// Try to find a better selector from available elements
		if (session.pageSnapshot && session.pageSnapshot.elements) {
			const bestSelector = await session.aiProcessor.findBestSelector(
				session.pageSnapshot.elements,
				"type",
				text,
			);
			if (bestSelector) {
				selector = bestSelector;
			}
		}

		safeWebSocketSend(ws, {
			type: "action_start",
			action: "type",
			selector: selector,
			text: text,
			message: `⌨️ Typing "${text}" into: ${selector}`,
		});

		const result = await session.handler.handleTool(
			"element_type",
			{ selector, text, timeout: 10000 },
			(progress) => {
				safeWebSocketSend(ws, {
					type: "progress",
					...progress,
				});
			},
		);

		session.testSteps.push(`await page.fill('${selector}', '${text}');`);
		session.lastAction = { type: "type", text, selector };

		safeWebSocketSend(ws, {
			type: "action_complete",
			action: "type",
			selector: selector,
			text: text,
			success: true,
			playwrightCode: `await page.fill('${selector}', '${text}');`,
			message: `✅ Successfully typed: "${text}"`,
		});
	} catch (error) {
		console.error("Type error:", error);
		safeWebSocketSend(ws, {
			type: "error",
			message: `❌ Type failed: ${error.message}`,
		});
	}
}

async function handleSearch(session, actionCommand) {
	const ws = session.ws;

	if (!session.isActive) {
		safeWebSocketSend(ws, {
			type: "error",
			message: "Please navigate to a website first",
		});
		return;
	}

	try {
		let searchBox = null;

		// Try to find search input from available elements
		if (session.pageSnapshot && session.pageSnapshot.elements) {
			const searchInput = session.pageSnapshot.elements.find(
				(el) =>
					(el.tag === "input" || el.tag === "textarea") &&
					(el.type === "search" ||
						el.name?.toLowerCase().includes("search") ||
						el.placeholder?.toLowerCase().includes("search") ||
						el.id?.toLowerCase().includes("search") ||
						el.className?.toLowerCase().includes("search")),
			);

			if (searchInput) {
				searchBox = searchInput.selector;
			}
		}

		// Fallback to generic search selectors
		if (!searchBox) {
			searchBox = 'input[name="q"], input[type="search"], textarea[name="q"]';
		}

		safeWebSocketSend(ws, {
			type: "action_start",
			action: "search",
			query: actionCommand.query,
			selector: searchBox,
			message: `🔍 Searching for: "${actionCommand.query}"`,
		});

		// Type the search query
		await session.handler.handleTool(
			"element_type",
			{
				selector: searchBox,
				text: actionCommand.query,
				timeout: 10000,
			},
			(progress) => {
				safeWebSocketSend(ws, {
					type: "progress",
					...progress,
				});
			},
		);

		session.testSteps.push(
			`await page.fill('${searchBox}', '${actionCommand.query}');`,
		);

		// Wait a bit before pressing Enter
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Press Enter to submit
		await session.handler.handleTool(
			"keyboard_press",
			{ key: "Enter" },
			(progress) => {
				safeWebSocketSend(ws, {
					type: "progress",
					...progress,
				});
			},
		);

		session.testSteps.push(`await page.keyboard.press('Enter');`);

		// Wait for search results
		await new Promise((resolve) => setTimeout(resolve, 2000));

		try {
			const newSnapshot = await session.handler.handleTool(
				"page_get_snapshot",
				{},
				() => {},
			);
			session.pageSnapshot = newSnapshot.snapshot;

			safeWebSocketSend(ws, {
				type: "action_complete",
				action: "search",
				query: actionCommand.query,
				success: true,
				newElements: newSnapshot.snapshot.elements || [],
				playwrightCode: `await page.fill('${searchBox}', '${actionCommand.query}');\nawait page.keyboard.press('Enter');`,
				message: `✅ Successfully searched for: "${actionCommand.query}"`,
			});
		} catch (snapshotError) {
			console.error("Post-search snapshot error:", snapshotError);
			safeWebSocketSend(ws, {
				type: "action_complete",
				action: "search",
				query: actionCommand.query,
				success: true,
				message: `✅ Successfully searched for: "${actionCommand.query}"`,
			});
		}
	} catch (error) {
		console.error("Search error:", error);
		safeWebSocketSend(ws, {
			type: "error",
			message: `❌ Search failed: ${error.message}. Try navigating to a search page first.`,
		});
	}
}

async function handleScroll(session, actionCommand) {
	const ws = session.ws;

	if (!session.isActive) {
		safeWebSocketSend(ws, {
			type: "error",
			message: "Please navigate to a website first",
		});
		return;
	}

	try {
		safeWebSocketSend(ws, {
			type: "action_start",
			action: "scroll",
			direction: actionCommand.direction,
			message: `📜 Scrolling ${actionCommand.direction}...`,
		});

		const result = await session.handler.handleTool(
			"page_scroll",
			{ direction: actionCommand.direction },
			(progress) => {
				safeWebSocketSend(ws, {
					type: "progress",
					...progress,
				});
			},
		);

		const scrollAmount =
			actionCommand.direction === "down"
				? 300
				: actionCommand.direction === "up"
				  ? -300
				  : 0;
		session.testSteps.push(
			`await page.evaluate(() => window.scrollBy(0, ${scrollAmount}));`,
		);

		safeWebSocketSend(ws, {
			type: "action_complete",
			action: "scroll",
			direction: actionCommand.direction,
			success: true,
			playwrightCode: `await page.evaluate(() => window.scrollBy(0, ${scrollAmount}));`,
			message: `✅ Scrolled ${actionCommand.direction}`,
		});
	} catch (error) {
		console.error("Scroll error:", error);
		safeWebSocketSend(ws, {
			type: "error",
			message: `❌ Scroll failed: ${error.message}`,
		});
	}
}

async function handleWait(session, actionCommand) {
	const ws = session.ws;

	if (!session.isActive) {
		safeWebSocketSend(ws, {
			type: "error",
			message: "Please navigate to a website first",
		});
		return;
	}

	try {
		const selector = actionCommand.selector;

		safeWebSocketSend(ws, {
			type: "action_start",
			action: "wait",
			selector: selector,
			message: `⏳ Waiting for: ${selector}`,
		});

		const result = await session.handler.handleTool(
			"element_wait",
			{ selector, timeout: 10000 },
			(progress) => {
				safeWebSocketSend(ws, {
					type: "progress",
					...progress,
				});
			},
		);

		session.testSteps.push(`await page.waitForSelector('${selector}');`);

		safeWebSocketSend(ws, {
			type: "action_complete",
			action: "wait",
			selector: selector,
			success: true,
			playwrightCode: `await page.waitForSelector('${selector}');`,
			message: `✅ Element appeared: ${selector}`,
		});
	} catch (error) {
		console.error("Wait error:", error);
		safeWebSocketSend(ws, {
			type: "error",
			message: `❌ Wait failed: ${error.message}`,
		});
	}
}

async function handlePressKey(session, actionCommand) {
	const ws = session.ws;

	if (!session.isActive) {
		safeWebSocketSend(ws, {
			type: "error",
			message: "Please navigate to a website first",
		});
		return;
	}

	try {
		safeWebSocketSend(ws, {
			type: "action_start",
			action: "press_key",
			key: actionCommand.key,
			message: `⌨️ Pressing: ${actionCommand.key}`,
		});

		const result = await session.handler.handleTool(
			"keyboard_press",
			{ key: actionCommand.key },
			(progress) => {
				safeWebSocketSend(ws, {
					type: "progress",
					...progress,
				});
			},
		);

		session.testSteps.push(
			`await page.keyboard.press('${actionCommand.key}');`,
		);

		// Wait for potential changes
		await new Promise((resolve) => setTimeout(resolve, 1000));

		try {
			const newSnapshot = await session.handler.handleTool(
				"page_get_snapshot",
				{},
				() => {},
			);
			session.pageSnapshot = newSnapshot.snapshot;

			safeWebSocketSend(ws, {
				type: "action_complete",
				action: "press_key",
				key: actionCommand.key,
				success: true,
				newElements: newSnapshot.snapshot.elements || [],
				playwrightCode: `await page.keyboard.press('${actionCommand.key}');`,
				message: `✅ Successfully pressed: ${actionCommand.key}`,
			});
		} catch (snapshotError) {
			console.error("Post-keypress snapshot error:", snapshotError);
			safeWebSocketSend(ws, {
				type: "action_complete",
				action: "press_key",
				key: actionCommand.key,
				success: true,
				message: `✅ Successfully pressed: ${actionCommand.key}`,
			});
		}
	} catch (error) {
		console.error("Key press error:", error);
		safeWebSocketSend(ws, {
			type: "error",
			message: `❌ Key press failed: ${error.message}`,
		});
	}
}

async function handleScreenshot(session) {
	const ws = session.ws;

	if (!session.isActive) {
		safeWebSocketSend(ws, {
			type: "error",
			message: "Please navigate to a website first",
		});
		return;
	}

	try {
		safeWebSocketSend(ws, {
			type: "action_start",
			action: "screenshot",
			message: "📸 Taking screenshot...",
		});

		const result = await session.handler.handleTool(
			"page_screenshot",
			{ fullPage: false },
			(progress) => {
				safeWebSocketSend(ws, {
					type: "progress",
					...progress,
				});
			},
		);

		session.testSteps.push(
			`await page.screenshot({ path: 'screenshot.png' });`,
		);

		safeWebSocketSend(ws, {
			type: "screenshot_taken",
			screenshot: result.screenshot,
			playwrightCode: `await page.screenshot({ path: 'screenshot.png' });`,
			message: "✅ Screenshot captured successfully",
		});
	} catch (error) {
		console.error("Screenshot error:", error);
		safeWebSocketSend(ws, {
			type: "error",
			message: `❌ Screenshot failed: ${error.message}`,
		});
	}
}

async function generateTest(session) {
	const ws = session.ws;

	if (session.testSteps.length === 0) {
		safeWebSocketSend(ws, {
			type: "error",
			message:
				"❌ No actions recorded yet. Perform some actions first, then try generating test cases.",
		});
		return;
	}

	try {
		safeWebSocketSend(ws, {
			type: "status",
			message: "🧪 Generating comprehensive test cases...",
		});

		const testCode = `const { test, expect } = require('@playwright/test');

test.describe('AI Generated Test Suite', () => {
    test.beforeEach(async ({ page }) => {
        // Set longer timeouts for complex interactions
        page.setDefaultTimeout(30000);
        page.setDefaultNavigationTimeout(45000);
    });

    test('Recorded User Journey - ${new Date().toLocaleDateString()}', async ({ page }) => {
        // Test generated from recorded actions
        // Total steps: ${session.testSteps.length}
        // URL: ${session.currentUrl || "N/A"}
        
        try {
${session.testSteps.map((step) => `            ${step}`).join("\n")}
            
            // Verify the page loaded successfully
            await expect(page).toHaveURL(/.*/);
            
            console.log('✅ Test completed successfully');
        } catch (error) {
            console.error('❌ Test failed:', error);
            throw error;
        }
    });

    test('Page Load Performance Check', async ({ page }) => {
        const start = Date.now();
        await page.goto('${session.currentUrl || "https://google.com"}');
        const loadTime = Date.now() - start;
        
        expect(loadTime).toBeLessThan(10000); // Should load within 10 seconds
        console.log(\`Page loaded in \${loadTime}ms\`);
    });

    test('Basic Accessibility Check', async ({ page }) => {
        await page.goto('${session.currentUrl || "https://google.com"}');
        
        // Check for basic accessibility elements
        const title = await page.title();
        expect(title).toBeTruthy();
        expect(title.length).toBeGreaterThan(0);
        
        console.log(\`Page title: \${title}\`);
    });
});`;

		const fileName = `ai-generated-test-${Date.now()}.spec.js`;
		const testDir = path.join(__dirname, "generated-tests");

		await fs.mkdir(testDir, { recursive: true });
		await fs.writeFile(path.join(testDir, fileName), testCode);

		safeWebSocketSend(ws, {
			type: "test_generated",
			testCode: testCode,
			fileName: fileName,
			stepsCount: session.testSteps.length,
			message: `🧪 Generated comprehensive test suite with ${session.testSteps.length} recorded steps + additional validation tests`,
		});

		// Also show the code in the UI
		safeWebSocketSend(ws, {
			type: "action_complete",
			action: "generate_test",
			success: true,
			playwrightCode: testCode,
			message: `✅ Test generation complete! File saved: ${fileName}`,
		});
	} catch (error) {
		console.error("Test generation error:", error);
		safeWebSocketSend(ws, {
			type: "error",
			message: `❌ Test generation failed: ${error.message}`,
		});
	}
}

// API endpoints
app.get("/api/health", (req, res) => {
	res.json({
		status: "OK",
		message: "AI-Powered Playwright Automation",
		activeSessions: activeSessions.size,
		activeConnections: activeConnections.size,
		features: [
			"AI natural language processing",
			"Smart element detection",
			"Automated test generation",
			"Enhanced error handling",
		],
	});
});

app.get("/", (req, res) => {
	res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, req, res, next) => {
	console.error("Express error:", error);
	res.status(500).json({
		error: "Internal server error",
		message: error.message,
	});
});

async function createDirectories() {
	try {
		await fs.mkdir(path.join(__dirname, "generated-tests"), {
			recursive: true,
		});
		await fs.mkdir(path.join(__dirname, "public"), { recursive: true });
		console.log("✅ Directories created successfully");
	} catch (error) {
		console.error("❌ Directory creation error:", error.message);
	}
}

// Graceful shutdown
process.on("SIGTERM", () => {
	console.log("SIGTERM received, shutting down gracefully");
	server.close(() => {
		console.log("Server closed");
		process.exit(0);
	});
});

process.on("SIGINT", () => {
	console.log("SIGINT received, shutting down gracefully");
	server.close(() => {
		console.log("Server closed");
		process.exit(0);
	});
});

// Start server
createDirectories()
	.then(() => {
		server.listen(PORT, () => {
			console.log(`🚀 AI-Powered Playwright Automation Server`);
			console.log(`🤖 Natural language interface: http://localhost:${PORT}`);
			console.log(`🎯 Smart element detection and action planning`);
			console.log(`🧪 Automated test case generation`);
			console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
		});
	})
	.catch((error) => {
		console.error("Failed to start server:", error);
		process.exit(1);
	});

module.exports = app;
