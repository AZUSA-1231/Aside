import { createServer } from "node:http";
import WebSocket from "ws";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";
const BODY_SAMPLE_LIMIT = 1_200;
const BODY_BYTE_LIMIT = 8 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;

function parseEndpoint() {
  const endpointFlag = process.argv.indexOf("--endpoint");
  const endpoint =
    endpointFlag >= 0 ? process.argv[endpointFlag + 1] : process.argv[2];
  return new URL(endpoint || DEFAULT_ENDPOINT);
}

function endpointUrl(endpoint, path) {
  const url = new URL(path, endpoint);
  url.pathname = path;
  url.search = "";
  return url;
}

async function fetchJson(endpoint, path) {
  const response = await fetch(endpointUrl(endpoint, path));
  if (!response.ok) {
    throw new Error(`CDP HTTP ${response.status} for ${path}`);
  }
  return response.json();
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sanitizeUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    return {
      protocol: url.protocol,
      origin: url.origin,
      pathname: url.pathname,
      queryKeys: [...new Set(url.searchParams.keys())].sort(),
      hasQuery: url.search.length > 0,
      hasHash: url.hash.length > 0,
    };
  } catch {
    return { invalid: true };
  }
}

function sanitizeTarget(target) {
  return {
    id: target.id ?? target.targetId,
    type: target.type,
    title: typeof target.title === "string" ? target.title : "",
    url: sanitizeUrl(target.url),
    attached: target.attached === true,
    hasFavicon: typeof target.faviconUrl === "string",
    hasOpener: typeof target.openerId === "string",
  };
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function safeError(error) {
  const message = errorMessage(error);
  return {
    status: "error",
    message: message
      .replace(/fixture-secret/gi, "<redacted>")
      .replace(/fixture-password/gi, "<redacted>"),
  };
}

async function safely(callback) {
  try {
    return await callback();
  } catch (error) {
    return safeError(error);
  }
}

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (process.env.ASIDE_CDP_DEBUG === "1") {
        console.error(`[cdp ${this.url}]`, JSON.stringify(message));
      }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "CDP command failed"));
      } else {
        pending.resolve(message.result ?? {});
      }
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out connecting to the CDP WebSocket.")),
        REQUEST_TIMEOUT_MS,
      );
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Could not connect to the CDP WebSocket."));
      });
    });
  }

  async send(method, params = {}, sessionId) {
    if (!this.socket) throw new Error("CDP connection is not open.");
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.socket.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    );
    return promise;
  }

  close() {
    for (const pending of this.pending.values()) {
      pending.reject(new Error("CDP connection closed."));
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
  }
}

const fixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Aside Chromium Probe</title>
  </head>
  <body>
    <main>
      <h1>Chromium capture fixture</h1>
      <p id="selection">This sentence is the explicit selection sample.</p>
      <p id="long-text">Bounded page text sample. ${"Repeated reference text. ".repeat(80)}</p>
      <form id="sample-form">
        <label>Search <input type="search" name="query" value="visible sample"></label>
        <label>Secret <input type="password" name="password" autocomplete="current-password" value="fixture-password"></label>
        <label>Notes <textarea name="notes">A visible note in a form control.</textarea></label>
        <input type="hidden" name="csrf" value="fixture-secret">
        <div contenteditable="true" aria-label="Editable sample">Editable page content.</div>
      </form>
      <iframe title="same origin frame" src="/frame"></iframe>
    </main>
    <script>
      document.cookie = "client_cookie=fixture-secret; SameSite=Lax";
      window.localStorage.setItem("private-token", "fixture-secret");
    </script>
  </body>
</html>`;

const frameHtml = `<!doctype html>
<html><head><title>Probe frame</title></head><body><p>Frame-only reference.</p></body></html>`;

async function startFixtureServer() {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/fixture")) {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": "server_cookie=fixture-secret; HttpOnly; SameSite=Lax",
      });
      response.end(fixtureHtml);
      return;
    }
    if (request.url === "/frame") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(frameHtml);
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The fixture server did not expose a TCP port.");
  }
  return { server, port: address.port };
}

async function findTarget(endpoint, targetId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const targets = await fetchJson(endpoint, "/json/list");
    const target = targets.find((candidate) => candidate.id === targetId);
    if (target?.webSocketDebuggerUrl) return target;
    await wait(100);
  }
  throw new Error("The temporary CDP target did not become available.");
}

async function evaluate(page, expression) {
  const response = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error("The page evaluation failed.");
  }
  return response.result?.value;
}

function summarizeFrameTree(tree) {
  const frames = [];
  function visit(node, parentId = null) {
    if (!node?.frame) return;
    frames.push({
      id: node.frame.id,
      parentId,
      url: sanitizeUrl(node.frame.url),
      name: node.frame.name || null,
      securityOrigin: node.frame.securityOrigin || null,
    });
    for (const child of node.childFrames || []) visit(child, node.frame.id);
  }
  visit(tree.frameTree);
  return { count: frames.length, frames };
}

function summarizeAccessibility(tree) {
  const nodes = tree.nodes || [];
  const roles = {};
  for (const node of nodes) {
    const role = node.role?.value || "unknown";
    roles[role] = (roles[role] || 0) + 1;
  }
  return {
    nodeCount: nodes.length,
    roles,
    namesObserved: nodes.filter((node) => node.name?.value).length,
  };
}

function summarizeNavigationHistory(history) {
  return {
    currentIndex: history.currentIndex,
    entries: (history.entries || []).map((entry) => ({
      id: entry.id,
      userTypedURL: sanitizeUrl(entry.userTypedURL),
      url: sanitizeUrl(entry.url),
      title: entry.title || "",
    })),
  };
}

async function runProbe() {
  const endpoint = parseEndpoint();
  const { server, port } = await startFixtureServer();
  let browser;
  let pageSessionId;
  let temporaryTargetId;

  try {
    const version = await fetchJson(endpoint, "/json/version");
    const listedBefore = await fetchJson(endpoint, "/json/list");
    browser = new CdpConnection(version.webSocketDebuggerUrl);
    await browser.connect();

    const browserVersion = await safely(() => browser.send("Browser.getVersion"));
    const targetStateBefore = await safely(() => browser.send("Target.getTargets"));
    const fixtureUrl =
      `http://127.0.0.1:${port}/fixture?token=fixture-secret&topic=selection#sample`;
    const created = await browser.send("Target.createTarget", { url: fixtureUrl });
    temporaryTargetId = created.targetId;
    const target = await findTarget(endpoint, temporaryTargetId);
    const attached = await browser.send("Target.attachToTarget", {
      targetId: temporaryTargetId,
      flatten: true,
    });
    pageSessionId = attached.sessionId;
    const page = {
      send: (method, params = {}) =>
        browser.send(method, params, pageSessionId),
    };

    const pageEnable = await safely(() => page.send("Page.enable"));
    const runtimeEnable = await safely(() => page.send("Runtime.enable"));
    await page.send("Page.navigate", { url: fixtureUrl });
    await evaluate(
      page,
      `new Promise((resolve) => {
        const check = () => document.readyState === "complete" ? resolve(true) : setTimeout(check, 20);
        check();
      })`,
    );

    await evaluate(
      page,
      `(() => {
        const element = document.getElementById("selection");
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      })()`,
    );

    const urlAndTitle = await safely(() =>
      evaluate(
        page,
        `(() => ({
          title: document.title,
          protocol: location.protocol,
          origin: location.origin,
          pathname: location.pathname,
          queryKeys: [...new Set([...new URL(location.href).searchParams.keys()])].sort(),
          hasHash: location.hash.length > 0,
        }))()`,
      ),
    );
    const selection = await safely(() =>
      evaluate(page, `(() => {
        const text = window.getSelection()?.toString() || "";
        return { text, characters: text.length, bytes: new TextEncoder().encode(text).byteLength };
      })()`),
    );
    const pageText = await safely(() =>
      evaluate(
        page,
        `(() => {
          const text = document.body?.innerText || "";
          const sample = text.slice(0, ${BODY_SAMPLE_LIMIT});
          return {
            characters: text.length,
            bytes: new TextEncoder().encode(text).byteLength,
            boundedSample: sample,
            truncated: text.length > ${BODY_SAMPLE_LIMIT},
            withinAsideTextBlock: new TextEncoder().encode(text.slice(0, ${BODY_SAMPLE_LIMIT})).byteLength <= ${BODY_BYTE_LIMIT},
          };
        })()`,
      ),
    );
    const formMetadata = await safely(() =>
      evaluate(
        page,
        `(() => [...document.querySelectorAll("input, textarea, select, [contenteditable=\\"true\\"]")].map((element) => ({
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute("type") || null,
          name: element.getAttribute("name") || null,
          id: element.id || null,
          autocomplete: element.getAttribute("autocomplete") || null,
          ariaLabel: element.getAttribute("aria-label") || null,
          disabled: Boolean(element.disabled),
          readOnly: Boolean(element.readOnly),
          valuePresent: "value" in element ? Boolean(element.value) : null,
          valueLength: "value" in element ? String(element.value).length : null,
        })))()`,
      ),
    );
    const pageState = await safely(() =>
      evaluate(
        page,
        `(() => ({
          visibilityState: document.visibilityState,
          hasFocus: document.hasFocus(),
          activeElement: (() => {
            const element = document.activeElement;
            return element ? {
              tag: element.tagName.toLowerCase(),
              type: element.getAttribute("type") || null,
              name: element.getAttribute("name") || null,
              id: element.id || null,
              ariaLabel: element.getAttribute("aria-label") || null,
            } : null;
          })(),
          viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
          chromeTabsApiVisible: typeof window.chrome === "object" && typeof window.chrome?.tabs === "object",
        }))()`,
      ),
    );
    const browserDataExposure = await safely(() =>
      evaluate(
        page,
        `(() => ({
          documentCookieReadable: document.cookie.length > 0,
          documentCookieNames: document.cookie.split(";").map((entry) => entry.trim().split("=", 1)[0]).filter(Boolean),
          localStorageKeys: Object.keys(window.localStorage),
          localStorageValuesReadable: Object.keys(window.localStorage).every((key) => window.localStorage.getItem(key) !== null),
          passwordValueReadable: (() => {
            const field = document.querySelector('input[type="password"]');
            return Boolean(field && field.value);
          })(),
        }))()`,
      ),
    );
    const networkCookies = await safely(async () => {
      const cookies = await page.send("Network.getAllCookies");
      return {
        count: cookies.cookies?.length || 0,
        cookies: (cookies.cookies || []).map((cookie) => ({
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite || null,
          valueOmitted: true,
        })),
      };
    });
    const domDocument = await safely(() => page.send("DOM.getDocument", { depth: 1 }));
    const frameTree = await safely(() => page.send("Page.getFrameTree"));
    const navigationHistory = await safely(() => page.send("Page.getNavigationHistory"));
    const layoutMetrics = await safely(() => page.send("Page.getLayoutMetrics"));
    const accessibility = await safely(() => page.send("Accessibility.getFullAXTree", { depth: 5 }));
    const snapshot = await safely(() => page.send("Page.captureSnapshot", { format: "mhtml" }));
    const screenshot = await safely(() => page.send("Page.captureScreenshot", { format: "png" }));
    const listedAfter = await fetchJson(endpoint, "/json/list");
    const targetStateAfter = await safely(() => browser.send("Target.getTargets"));

    const report = {
      probe: {
        name: "aside-chromium-cdp-probe",
        generatedAt: new Date().toISOString(),
        endpoint: `${endpoint.protocol}//${endpoint.host}`,
        fixture: "temporary local page; secrets are synthetic and omitted from output",
      },
      browser: {
        versionEndpoint: {
          browser: version.Browser,
          protocolVersion: version["Protocol-Version"],
          userAgent: version["User-Agent"],
          v8Version: version["V8-Version"],
          webKitVersion: version["WebKit-Version"],
          websocketAvailable: typeof version.webSocketDebuggerUrl === "string",
        },
        getVersion: browserVersion,
        targetDiscoveryBefore: {
          jsonListCount: listedBefore.length,
          targets: listedBefore.map(sanitizeTarget),
          targetGetTargets: targetStateBefore?.targetInfos?.map(sanitizeTarget) || targetStateBefore,
        },
        targetDiscoveryAfter: {
          jsonListCount: listedAfter.length,
          targets: listedAfter.map(sanitizeTarget),
          targetGetTargets: targetStateAfter?.targetInfos?.map(sanitizeTarget) || targetStateAfter,
          activeTargetExplicitlyReported: false,
        },
        controlSurface: {
          canCreateAndCloseTarget: true,
          canEvaluatePageScript: true,
          warning: "A reachable CDP endpoint is a powerful control surface; it must be explicitly opted into and bound to a user-approved target.",
        },
      },
      page: {
        target: sanitizeTarget(target),
        domainEnable: { page: pageEnable, runtime: runtimeEnable },
        identity: urlAndTitle,
        selection: selection,
        boundedText: pageText,
        frameTree: frameTree?.status === "error" ? frameTree : summarizeFrameTree(frameTree),
        navigationHistory: navigationHistory?.status === "error" ? navigationHistory : summarizeNavigationHistory(navigationHistory),
        formMetadata,
        activeState: pageState,
        networkCookies,
        domDocument: domDocument?.status === "error" ? domDocument : {
          rootNodeName: domDocument.root?.nodeName || null,
          rootNodeId: domDocument.root?.nodeId || null,
          rootChildCount: domDocument.root?.children?.length || 0,
        },
        accessibility: accessibility?.status === "error" ? accessibility : summarizeAccessibility(accessibility),
        captureFormats: {
          snapshot: snapshot?.status === "error" ? snapshot : {
            format: "mhtml",
            bytes: byteLength(snapshot.data || ""),
            contentOmitted: true,
          },
          screenshot: screenshot?.status === "error" ? screenshot : {
            format: "png",
            bytes: Buffer.byteLength(screenshot.data || "", "base64"),
            pixelsOmitted: true,
          },
        },
        browserDataExposure,
      },
      interpretation: {
        usefulForAttachment: [
          "browser identity from the native target plus CDP browser version",
          "active target title and a sanitized URL",
          "explicit window selection",
          "bounded visible page text when the user asks for it",
          "bounded frame/document metadata when an adapter chooses to support it",
        ],
        keepOutOfDefaultAttachment: [
          "passwords, hidden fields, form values, cookies, storage values, and auth material",
          "raw unbounded DOM, MHTML snapshots, screenshots, and accessibility trees",
          "all tabs or browsing history without an explicit target and user action",
          "CDP control commands such as navigation, input, or arbitrary script execution",
        ],
      },
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (browser && temporaryTargetId) {
      if (pageSessionId) {
        await safely(() =>
          browser.send("Target.detachFromTarget", { sessionId: pageSessionId }),
        );
      }
      await safely(() => browser.send("Target.closeTarget", { targetId: temporaryTargetId }));
    }
    browser?.close();
    server.closeAllConnections?.();
    server.close();
  }
}

runProbe().catch((error) => {
  console.error(JSON.stringify({ probe: "aside-chromium-cdp-probe", ...safeError(error) }, null, 2));
  process.exitCode = 1;
});
