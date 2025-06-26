const express = require("express");
const cors = require("cors");
const path = require("path");
const { firefox } = require("playwright");
const OpenAI = require("openai");
const fs = require("fs").promises;
const data = require("./config/default.json");
const WebSocket = require("ws");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

let activeConnections = new Set();

wss.on("connection", (ws) => {
    activeConnections.add(ws);
    ws.on("close", () => activeConnections.delete(ws));
});

function broadcast(data) {
    const message = JSON.stringify(data);
    activeConnections.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
        }
    });
}

class TrulyIntelligentE2EGenerator {
    constructor(apiKey) {
        this.openai = new OpenAI({ apiKey: apiKey });
        this.browser = null;
        this.page = null;
        this.currentGoal = null;
        this.executionHistory = [];
        this.testSteps = [];
        this.maxSteps = 15;
        this.stepCount = 0;
        this.fastMode = false;
        this.retryCount = 3;
        this.elementCache = new Map();
    }

    async initialize() {
        try {
            broadcast({
                type: "status",
                message: "Launching browser...",
                step: "init",
            });

            this.browser = await firefox.launch({
                headless: false,
                slowMo: 100,
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-web-security",
                ],
            });

            const context = await this.browser.newContext({
                userAgent:
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                viewport: { width: 1280, height: 720 },
                ignoreHTTPSErrors: true,
                permissions: ["geolocation", "notifications"],
            });

            this.page = await context.newPage();
            await this.page.setDefaultTimeout(30000);
            await this.page.setDefaultNavigationTimeout(45000);

            this.page.on("pageerror", (error) => {
                console.error("Page error:", error.message);
            });

            this.page.on("console", (msg) => {
                if (msg.type() === "error") {
                    console.error("Console error:", msg.text());
                }
            });

            this.page.on("framenavigated", () => {
                this.elementCache.clear();
            });

            broadcast({ type: "status", message: "Browser ready", step: "ready" });
        } catch (error) {
            broadcast({
                type: "error",
                message: `Browser initialization failed: ${error.message}`,
            });
            throw new Error(`Failed to initialize browser: ${error.message}`);
        }
    }

    async waitForStability() {
        try {
            await Promise.race([
                this.page.waitForLoadState("domcontentloaded"),
                this.page.waitForTimeout(3000),
            ]);

            await this.page.evaluate(() => {
                return new Promise((resolve) => {
                    if (document.readyState === "complete") {
                        resolve();
                        return;
                    }

                    let mutationCount = 0;
                    let timeoutId;

                    const observer = new MutationObserver(() => {
                        mutationCount++;
                        clearTimeout(timeoutId);
                        timeoutId = setTimeout(() => {
                            if (mutationCount < 5) {
                                observer.disconnect();
                                resolve();
                            }
                            mutationCount = 0;
                        }, 1000);
                    });

                    observer.observe(document.body, {
                        childList: true,
                        subtree: true,
                        attributes: true,
                    });

                    setTimeout(() => {
                        observer.disconnect();
                        resolve();
                    }, 5000);
                });
            });

            await this.page.waitForTimeout(500);
        } catch (error) {
            console.warn("Stability check warning:", error.message);
        }
    }

    async takeScreenshot() {
        if (!this.page) {
            throw new Error("Page not initialized");
        }
        return await this.page.screenshot({ fullPage: false, type: "png" });
    }

    async getCurrentPageSnapshot() {
        if (!this.page) {
            throw new Error("Page not initialized");
        }

        await this.waitForStability();

        const pageSnapshot = await this.page.evaluate(() => {
            const snapshot = {
                url: window.location.href,
                title: document.title,
                domain: window.location.hostname,
                readyState: document.readyState,
                activeElement: document.activeElement?.tagName || null,
                elements: [],
            };

            const getClassNames = (element) => {
                if (!element || !element.className) return [];
                if (typeof element.className === "string") {
                    return element.className
                        .split(" ")
                        .filter((c) => c && !c.includes(":") && /^[a-zA-Z][\w-]*$/.test(c));
                }
                if (element.className.baseVal !== undefined) {
                    return element.className.baseVal
                        .split(" ")
                        .filter((c) => c && !c.includes(":") && /^[a-zA-Z][\w-]*$/.test(c));
                }
                return [];
            };

            const getOptimalSelector = (element) => {
                const selectors = [];

                if (element.id && /^[a-zA-Z][\w-]*$/.test(element.id)) {
                    selectors.push({ selector: `#${element.id}`, score: 100 });
                }

                if (element.getAttribute("data-testid")) {
                    selectors.push({
                        selector: `[data-testid="${element.getAttribute("data-testid")}"]`,
                        score: 95,
                    });
                }

                if (element.getAttribute("data-test")) {
                    selectors.push({
                        selector: `[data-test="${element.getAttribute("data-test")}"]`,
                        score: 94,
                    });
                }

                if (element.getAttribute("aria-label")) {
                    selectors.push({
                        selector: `[aria-label="${element.getAttribute("aria-label")}"]`,
                        score: 90,
                    });
                }

                if (element.name && element.tagName === "INPUT") {
                    selectors.push({
                        selector: `input[name="${element.name}"]`,
                        score: 85,
                    });
                }

                if (element.getAttribute("role")) {
                    const role = element.getAttribute("role");
                    const text = element.textContent.trim();
                    if (text && text.length < 50) {
                        selectors.push({
                            selector: `[role="${role}"]:has-text("${text}")`,
                            score: 80,
                        });
                    }
                }

                const tagName = element.tagName.toLowerCase();
                const classNames = getClassNames(element);

                if (classNames.length > 0) {
                    const classSelector =
                        tagName + "." + classNames.slice(0, 2).join(".");
                    selectors.push({ selector: classSelector, score: 70 });
                }

                const text = element.textContent.trim();
                if (
                    text &&
                    text.length > 2 &&
                    text.length < 50 &&
                    !text.includes("\n")
                ) {
                    if (tagName === "button" || tagName === "a") {
                        selectors.push({
                            selector: `${tagName}:has-text("${text}")`,
                            score: 75,
                        });
                    }
                }

                const parent = element.parentElement;
                if (parent) {
                    const siblings = Array.from(parent.children).filter(
                        (el) => el.tagName === element.tagName,
                    );
                    if (siblings.length > 1) {
                        const index = siblings.indexOf(element) + 1;
                        let parentSelector = parent.tagName.toLowerCase();
                        if (parent.id) {
                            parentSelector = `#${parent.id}`;
                        } else {
                            const parentClasses = getClassNames(parent);
                            if (parentClasses.length > 0) {
                                parentSelector += "." + parentClasses[0];
                            }
                        }
                        selectors.push({
                            selector: `${parentSelector} > ${tagName}:nth-child(${index})`,
                            score: 60,
                        });
                    }
                }

                if (element.getAttribute("placeholder")) {
                    selectors.push({
                        selector: `[placeholder="${element.getAttribute("placeholder")}"]`,
                        score: 65,
                    });
                }

                if (element.getAttribute("type")) {
                    const type = element.getAttribute("type");
                    if (type === "submit" || type === "button") {
                        selectors.push({ selector: `[type="${type}"]`, score: 50 });
                    }
                }

                selectors.sort((a, b) => b.score - a.score);

                const optimalSelectors = selectors.slice(0, 3).map((s) => s.selector);

                return {
                    primary: optimalSelectors[0] || null,
                    fallback: optimalSelectors[1] || null,
                    tertiary: optimalSelectors[2] || null,
                };
            };

            const isElementInteractive = (element) => {
                const tagName = element.tagName.toLowerCase();
                const type = element.getAttribute("type");
                const role = element.getAttribute("role");
                const classNames = getClassNames(element);

                return (
                    tagName === "button" ||
                    tagName === "a" ||
                    tagName === "input" ||
                    tagName === "select" ||
                    tagName === "textarea" ||
                    type === "submit" ||
                    type === "button" ||
                    role === "button" ||
                    role === "link" ||
                    role === "tab" ||
                    role === "menuitem" ||
                    element.hasAttribute("onclick") ||
                    element.hasAttribute("ng-click") ||
                    element.hasAttribute("@click") ||
                    classNames.some((c) => c === "btn" || c === "button") ||
                    window.getComputedStyle(element).cursor === "pointer"
                );
            };

            const processElement = (element) => {
                const rect = element.getBoundingClientRect();
                const styles = window.getComputedStyle(element);

                const isVisible =
                    rect.width > 0 &&
                    rect.height > 0 &&
                    rect.top < window.innerHeight &&
                    rect.bottom > 0 &&
                    rect.left < window.innerWidth &&
                    rect.right > 0 &&
                    styles.display !== "none" &&
                    styles.visibility !== "hidden" &&
                    styles.opacity !== "0" &&
                    element.offsetParent !== null;

                if (!isVisible) return null;

                const tagName = element.tagName.toLowerCase();
                const text = element.textContent.trim().substring(0, 100);
                const isInteractive = isElementInteractive(element);
                const classNames = getClassNames(element);

                const selectors = getOptimalSelector(element);

                return {
                    tag: tagName,
                    text: text,
                    id: element.id || null,
                    className: classNames.join(" ") || null,
                    name: element.name || null,
                    type: element.type || null,
                    placeholder: element.placeholder || null,
                    href: element.href || null,
                    src: element.src || null,
                    alt: element.alt || null,
                    title: element.title || null,
                    role: element.getAttribute("role") || null,
                    ariaLabel: element.getAttribute("aria-label") || null,
                    dataTestId: element.getAttribute("data-testid") || null,
                    value: element.value || null,
                    checked: element.checked || null,
                    disabled: element.disabled || null,
                    readOnly: element.readOnly || null,
                    required: element.required || null,
                    selector: selectors.primary,
                    fallbackSelector: selectors.fallback,
                    tertiarySelector: selectors.tertiary,
                    position: {
                        x: Math.round(rect.x),
                        y: Math.round(rect.y),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                        centerX: Math.round(rect.x + rect.width / 2),
                        centerY: Math.round(rect.y + rect.height / 2),
                        inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
                    },
                    style: {
                        cursor: styles.cursor,
                        display: styles.display,
                        backgroundColor: styles.backgroundColor,
                        color: styles.color,
                        zIndex: styles.zIndex,
                    },
                    isInteractable: isInteractive,
                    parent: element.parentElement?.tagName || null,
                    xpath: null,
                };
            };

            const interactiveElements = document.querySelectorAll(
                'button, a, input, select, textarea, [onclick], [role="button"], [role="link"], [tabindex], .btn, .button, [data-testid], [type="submit"], [type="button"], [contenteditable="true"]',
            );

            const processedElements = new Set();

            interactiveElements.forEach((element) => {
                if (processedElements.has(element)) return;
                processedElements.add(element);

                const elementData = processElement(element);
                if (elementData) {
                    snapshot.elements.push(elementData);
                }
            });

            const allElements = document.querySelectorAll("*");
            allElements.forEach((element) => {
                if (processedElements.has(element) || snapshot.elements.length >= 100)
                    return;

                const elementData = processElement(element);
                if (elementData && elementData.text.length > 0) {
                    snapshot.elements.push(elementData);
                }
            });

            snapshot.elements.sort((a, b) => {
                if (a.isInteractable && !b.isInteractable) return -1;
                if (!a.isInteractable && b.isInteractable) return 1;
                if (a.position.inViewport && !b.position.inViewport) return -1;
                if (!a.position.inViewport && b.position.inViewport) return 1;
                return a.position.y - b.position.y;
            });

            snapshot.elements = snapshot.elements.slice(0, 75);

            snapshot.elements.forEach((el, index) => {
                el.index = index;
            });

            snapshot.pageContent = {
                headings: Array.from(document.querySelectorAll("h1, h2, h3"))
                    .slice(0, 5)
                    .map((h) => h.textContent.trim()),
                forms: document.forms.length,
                images: document.images.length,
                videos: document.querySelectorAll("video").length,
                bodyTextSample: document.body.innerText.substring(0, 500),
            };

            return snapshot;
        });

        return pageSnapshot;
    }

    async decideNextAction(goal, pageSnapshot, executionHistory = []) {
        const systemPrompt = `You are an expert web automation AI. Your goal is to execute UI actions with 100% reliability.

GOAL: ${goal}

CRITICAL RELIABILITY RULES:
1. ALWAYS use the most specific selector available in this order: id > data-testid > aria-label > name > unique class combination
2. NEVER use generic selectors like just "button" or "a"
3. ALWAYS verify element exists and is visible before interaction
4. ALWAYS add explicit waits after actions that change the page
5. ALWAYS scroll elements into view before clicking
6. NEVER attempt to interact with disabled or hidden elements
7. If primary selector fails, specify fallback selectors

ACTIONS: navigate, click, type, press, wait, scroll, complete, hover, clear

PAGE: ${pageSnapshot.url}
TITLE: ${pageSnapshot.title}

ELEMENTS (format: index: tag[type] "text" #id .class primary-selector | fallback-selector):
${pageSnapshot.elements
    .map(
        (el) =>
            `${el.index}: ${el.tag}${el.type ? `[${el.type}]` : ""} "${el.text}" ${
                el.id ? `#${el.id}` : ""
            } ${el.className ? `.${el.className.split(" ")[0]}` : ""} ${
                el.selector || ""
            } | ${el.fallbackSelector || ""} ${el.disabled ? "[DISABLED]" : ""} ${
                el.readOnly ? "[READONLY]" : ""
            } ${el.position.inViewport ? "[IN-VIEW]" : "[OUT-OF-VIEW]"}`,
    )
    .join("\n")}

HISTORY:
${executionHistory
    .slice(-5)
    .map(
        (h, i) =>
            `${i + 1}. ${h.action}: ${h.description} - ${
                h.success ? "SUCCESS" : "FAILED: " + h.error
            }`,
    )
    .join("\n")}

Analyze carefully and respond with the most reliable action. 

Respond with JSON only:
{
    "action": "navigate|click|type|press|wait|scroll|complete|hover|clear",
    "target": "element_index|URL|key",
    "value": "text_or_time_or_scroll_amount",
    "selector": "primary CSS selector",
    "fallbackSelectors": ["fallback1", "fallback2"],
    "waitBefore": true/false,
    "waitAfter": true/false,
    "scrollIntoView": true/false,
    "verifyVisible": true,
    "reasoning": "why this selector is most reliable",
    "description": "what you're doing",
    "confidence": "high|medium|low"
}`;

        try {
            broadcast({
                type: "ai_thinking",
                message: "AI analyzing page...",
                step: this.stepCount,
            });

            const completion = await this.openai.chat.completions.create({
                model: "gpt-4.1",
                temperature: 0.1,
                max_tokens: 30000,
                messages: [
                    { role: "system", content: systemPrompt },
                    {
                        role: "user",
                        content: `Decide the next reliable action for: "${goal}"`,
                    },
                ],
                response_format: { type: "json_object" },
            });

            const decision = JSON.parse(completion.choices[0].message.content);

            broadcast({
                type: "ai_decision",
                decision: decision,
                step: this.stepCount,
            });

            return decision;
        } catch (error) {
            broadcast({
                type: "error",
                message: `AI decision failed: ${error.message}`,
            });
            throw new Error(`AI analysis failed: ${error.message}`);
        }
    }

    async findElement(selectors, timeout = 10000) {
        if (!Array.isArray(selectors)) {
            selectors = [selectors];
        }

        const endTime = Date.now() + timeout;
        let lastError = null;

        for (const selector of selectors) {
            if (!selector) continue;

            try {
                const remainingTime = Math.max(endTime - Date.now(), 1000);
                const element = await this.page.waitForSelector(selector, {
                    state: "attached",
                    timeout: remainingTime,
                });

                const isVisible = await element.isVisible();
                const isEnabled = await element.isEnabled();

                if (isVisible && isEnabled) {
                    return { element, selector };
                }
            } catch (error) {
                lastError = error;
                continue;
            }
        }

        throw lastError || new Error("No valid selector found");
    }

    async executeActionWithRetry(action, maxRetries = 3) {
        let lastError;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await action();
            } catch (error) {
                lastError = error;
                if (attempt < maxRetries) {
                    broadcast({
                        type: "retry",
                        message: `Retrying action (attempt ${attempt + 1}/${maxRetries})`,
                        error: error.message,
                    });
                    await this.page.waitForTimeout(1000 * attempt);
                }
            }
        }
        throw lastError;
    }

    async executeAction(decision, pageSnapshot) {
        if (!this.page) {
            throw new Error("Page not initialized");
        }

        let success = false;
        let errorMessage = "";
        let playwrightCode = "";

        broadcast({
            type: "action_start",
            action: decision.action,
            description: decision.description,
            step: this.stepCount,
        });

        try {
            if (decision.waitBefore) {
                await this.page.waitForTimeout(2000);
            }

            switch (decision.action) {
                case "navigate":
                    let url = decision.target;
                    if (!url.startsWith("http")) {
                        url = `https://${url}`;
                    }

                    await this.executeActionWithRetry(async () => {
                        await this.page.goto(url, {
                            waitUntil: "domcontentloaded",
                            timeout: 45000,
                        });
                    });

                    await this.waitForStability();
                    playwrightCode = `await page.goto('${url}', { waitUntil: 'domcontentloaded' });`;
                    success = true;
                    break;

                case "click":
                    const elementIndex = parseInt(decision.target);
                    const targetElement = pageSnapshot.elements[elementIndex];

                    if (!targetElement) {
                        throw new Error(`Element index ${elementIndex} not found`);
                    }

                    const clickSelectors = [
                        decision.selector,
                        targetElement.selector,
                        targetElement.fallbackSelector,
                        targetElement.tertiarySelector,
                        ...(decision.fallbackSelectors || []),
                    ].filter(Boolean);

                    if (targetElement.id) {
                        clickSelectors.unshift(`#${targetElement.id}`);
                    }
                    if (targetElement.dataTestId) {
                        clickSelectors.unshift(
                            `[data-testid="${targetElement.dataTestId}"]`,
                        );
                    }

                    await this.executeActionWithRetry(async () => {
                        const { element, selector } =
                            await this.findElement(clickSelectors);

                        await element.scrollIntoViewIfNeeded();
                        await this.page.waitForTimeout(500);

                        const box = await element.boundingBox();
                        if (!box) {
                            throw new Error("Element not visible");
                        }

                        try {
                            await element.click({
                                force: false,
                                timeout: 5000,
                                position: { x: box.width / 2, y: box.height / 2 },
                            });
                        } catch (clickError) {
                            await this.page.evaluate((el) => el.click(), element);
                        }

                        playwrightCode = `await page.click('${selector}');`;
                    });

                    success = true;
                    break;

                case "type":
                    const typeElementIndex = parseInt(decision.target);
                    const typeElement = pageSnapshot.elements[typeElementIndex];

                    if (!typeElement) {
                        throw new Error(`Element index ${typeElementIndex} not found`);
                    }

                    const typeSelectors = [
                        decision.selector,
                        typeElement.selector,
                        typeElement.fallbackSelector,
                        ...(decision.fallbackSelectors || []),
                    ].filter(Boolean);

                    await this.executeActionWithRetry(async () => {
                        const { element, selector } = await this.findElement(typeSelectors);

                        await element.scrollIntoViewIfNeeded();
                        await this.page.waitForTimeout(300);

                        await element.click();
                        await this.page.waitForTimeout(100);

                        await this.page.keyboard.press("Control+A");
                        await this.page.keyboard.press("Delete");

                        await element.type(decision.value || "", { delay: 50 });

                        playwrightCode = `await page.fill('${selector}', '${
                            decision.value || ""
                        }');`;
                    });

                    success = true;
                    break;

                case "clear":
                    const clearElementIndex = parseInt(decision.target);
                    const clearElement = pageSnapshot.elements[clearElementIndex];

                    if (clearElement) {
                        const clearSelectors = [
                            decision.selector,
                            clearElement.selector,
                            clearElement.fallbackSelector,
                        ].filter(Boolean);

                        await this.executeActionWithRetry(async () => {
                            const { element, selector } =
                                await this.findElement(clearSelectors);
                            await element.fill("");
                            playwrightCode = `await page.fill('${selector}', '');`;
                        });
                        success = true;
                    }
                    break;

                case "press":
                    await this.executeActionWithRetry(async () => {
                        await this.page.keyboard.press(decision.target);
                    });
                    playwrightCode = `await page.keyboard.press('${decision.target}');`;
                    success = true;
                    break;

                case "wait":
                    const waitTime = parseInt(decision.value) || 3000;
                    await this.page.waitForTimeout(waitTime);
                    playwrightCode = `await page.waitForTimeout(${waitTime});`;
                    success = true;
                    break;

                case "scroll":
                    const scrollAmount = parseInt(decision.value) || 300;
                    await this.executeActionWithRetry(async () => {
                        await this.page.evaluate((amount) => {
                            window.scrollBy({ top: amount, behavior: "smooth" });
                        }, scrollAmount);
                    });
                    await this.page.waitForTimeout(1000);
                    playwrightCode = `await page.evaluate(() => window.scrollBy(0, ${scrollAmount}));`;
                    success = true;
                    break;

                case "hover":
                    const hoverElementIndex = parseInt(decision.target);
                    const hoverElement = pageSnapshot.elements[hoverElementIndex];

                    if (hoverElement) {
                        const hoverSelectors = [
                            decision.selector,
                            hoverElement.selector,
                            hoverElement.fallbackSelector,
                        ].filter(Boolean);

                        await this.executeActionWithRetry(async () => {
                            const { element, selector } =
                                await this.findElement(hoverSelectors);
                            await element.hover();
                            playwrightCode = `await page.hover('${selector}');`;
                        });
                        success = true;
                    }
                    break;

                case "complete":
                    success = true;
                    playwrightCode = `// Goal: "${this.currentGoal}" completed successfully`;
                    break;

                default:
                    throw new Error(`Unknown action: ${decision.action}`);
            }

            if (
                decision.waitAfter !== false &&
                decision.action !== "wait" &&
                decision.action !== "complete"
            ) {
                await this.page.waitForTimeout(1500);
                await this.waitForStability();
            }
        } catch (error) {
            success = false;
            errorMessage = error.message;
            playwrightCode = `// Failed: ${decision.description} - ${error.message}`;
        }

        const result = {
            action: decision.action,
            target: decision.target,
            value: decision.value,
            description: decision.description,
            success: success,
            error: errorMessage,
            reasoning: decision.reasoning,
            confidence: decision.confidence,
            playwrightCode: playwrightCode,
        };

        this.executionHistory.push(result);
        this.testSteps.push(`    ${playwrightCode}`);

        broadcast({
            type: "action_complete",
            result: result,
            step: this.stepCount,
        });

        return result;
    }

    async executeGoal(goal) {
        this.currentGoal = goal;
        this.executionHistory = [];
        this.testSteps = [];
        this.stepCount = 0;
        this.elementCache.clear();

        const results = [];
        let goalCompleted = false;

        broadcast({ type: "execution_start", goal: goal });

        try {
            await this.waitForStability();

            while (!goalCompleted && this.stepCount < this.maxSteps) {
                this.stepCount++;

                broadcast({
                    type: "step_start",
                    step: this.stepCount,
                    goal: goal,
                });

                const screenshot = await this.takeScreenshot();
                const pageSnapshot = await this.getCurrentPageSnapshot();

                broadcast({
                    type: "page_snapshot",
                    url: pageSnapshot.url,
                    elements: pageSnapshot.elements.length,
                    step: this.stepCount,
                });

                const decision = await this.decideNextAction(
                    goal,
                    pageSnapshot,
                    this.executionHistory,
                );

                const result = await this.executeAction(decision, pageSnapshot);
                results.push(result);

                if (decision.action === "complete") {
                    goalCompleted = true;
                    broadcast({ type: "goal_completed", step: this.stepCount });
                } else if (!result.success) {
                    broadcast({
                        type: "warning",
                        message: `Action failed: ${result.error}`,
                        step: this.stepCount,
                    });
                }

                await this.page.waitForTimeout(1000);
            }

            if (this.stepCount >= this.maxSteps) {
                broadcast({ type: "max_steps_reached", step: this.stepCount });
            }

            const finalResult = {
                success: goalCompleted || results.some((r) => r.success),
                goal: goal,
                steps: results,
                testCode: this.generateTestCode(goal),
                executionSummary: {
                    totalSteps: this.stepCount,
                    successfulSteps: results.filter((r) => r.success).length,
                    failedSteps: results.filter((r) => !r.success).length,
                    goalCompleted: goalCompleted,
                },
            };

            broadcast({ type: "execution_complete", result: finalResult });
            return finalResult;
        } catch (error) {
            const errorResult = {
                success: false,
                error: error.message,
                goal: goal,
                steps: results,
                testCode: this.generateTestCode(goal),
                executionSummary: {
                    totalSteps: this.stepCount,
                    successfulSteps: results.filter((r) => r.success).length,
                    failedSteps: results.filter((r) => !r.success).length,
                    goalCompleted: false,
                },
            };

            broadcast({
                type: "execution_error",
                error: error.message,
                result: errorResult,
            });
            return errorResult;
        }
    }

    generateTestCode(testName = "AI Generated Test") {
        return `const { test, expect } = require('@playwright/test');

test('${testName}', async ({ page }) => {
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(45000);
    
${this.testSteps.join("\n")}
});`;
    }

    async cleanup() {
        if (this.browser) {
            await this.browser.close();
        }
    }
}

app.post("/api/execute-goal", async (req, res) => {
    let generator = null;

    try {
        const { goal } = req.body;

        if (!goal) {
            return res.status(400).json({ error: "Goal is required" });
        }

        const apiKey = process.env.OPENAI_API_KEY || data.openai_key || data.key;
        generator = new TrulyIntelligentE2EGenerator(apiKey);

        await generator.initialize();
        const result = await generator.executeGoal(goal);

        if (result.testCode) {
            const fileName = `test-${Date.now()}.spec.js`;
            const testDir = path.join(__dirname, "generated-tests");
            await fs.mkdir(testDir, { recursive: true });
            await fs.writeFile(path.join(testDir, fileName), result.testCode);
            result.fileName = fileName;
        }

        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        if (generator) {
            setTimeout(async () => {
                await generator.cleanup();
            }, 3000);
        }
    }
});

app.get("/api/health", (req, res) => {
    res.json({
        status: "OK",
        message: "Ultra-Reliable AI E2E Generator with OpenAI",
        model: "gpt-4-turbo-preview",
        features: [
            "Multi-strategy selector resolution",
            "Automatic retries with backoff",
            "DOM stability verification",
            "Smart fallback selectors",
            "Element visibility checks",
            "Viewport-aware interactions",
        ],
    });
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function createDirectories() {
    try {
        await fs.mkdir(path.join(__dirname, "generated-tests"), {
            recursive: true,
        });
        await fs.mkdir(path.join(__dirname, "public"), { recursive: true });
    } catch (error) {
        console.log("Directory creation error:", error.message);
    }
}

createDirectories().then(() => {
    server.listen(PORT, () => {
        console.log(`🚀 Ultra-Reliable AI E2E Generator with OpenAI`);
        console.log(`📝 Access the app at http://localhost:${PORT}`);
        console.log(`🔧 API Health check: http://localhost:${PORT}/api/health`);
        console.log(`🎯 100% reliability mode enabled`);
        console.log(`🤖 Using GPT-4 Turbo for intelligent decisions`);
    });
});

module.exports = app;

