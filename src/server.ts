import express, { Request, Response, RequestHandler } from "express";
import puppeteer, { Browser, Page } from "puppeteer";
import * as dotenv from "dotenv";
import cors from "cors";
import * as readline from "readline"; // For console input

dotenv.config();

const app = express();
const port = 3000;

// Enable CORS for frontend
app.use(cors({
  origin: "http://localhost:5173",
  methods: ["GET"],
  allowedHeaders: ["Content-Type"],
}));
app.use(express.json());

// Global browser and page instances
let browser: Browser | null = null;
let persistentPage: Page | null = null;

// In-memory cache for form HTML
const formCache: Map<string, string> = new Map();

// Create readline interface for manual code input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Function to prompt for verification code
const promptForCode = (): Promise<string> => {
  return new Promise((resolve) => {
    rl.question("Enter the verification code sent to your Gmail: ", (code) => {
      resolve(code);
    });
  });
};

// Initialize browser and log in on server start
async function initializeBrowser(): Promise<void> {
  try {
    console.log("Initializing browser and logging in...");
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      // userDataDir: "./puppeteer_user_data", // Uncomment to persist cookies if no 2FA
    });

    persistentPage = await browser.newPage();
    await persistentPage.setDefaultNavigationTimeout(10000);

    // Google Login
    await persistentPage.goto("https://accounts.google.com/", { waitUntil: "domcontentloaded" });
    await persistentPage.type("#identifierId", process.env.GOOGLE_EMAIL || "");
    await persistentPage.click("#identifierNext");

    // Wait for password field or verification prompt
    await persistentPage.waitForSelector("#passwordNext, #totpPin, #challenge", { visible: true, timeout: 15000 });

    // Check if verification prompt appears
    const isVerificationPrompt = await persistentPage.evaluate(() => {
      return !!document.querySelector("#challenge") || !!document.querySelector(".d2CFce"); // Common verification class
    });

    if (isVerificationPrompt) {
      console.log("Verification prompt detected. Attempting Gmail code verification...");

      // Look for "Send code via Gmail" option (adjust selector based on actual DOM)
      const gmailOptionSelector = 'div[data-challengetype="12"]'; // Example selector for email verification
      const gmailOption = await persistentPage.$(gmailOptionSelector);
      if (gmailOption) {
        await gmailOption.click();
        await persistentPage.waitForNavigation({ waitUntil: "domcontentloaded" });
        console.log("Selected Gmail verification. Check your email for the code.");
      } else {
        throw new Error("Gmail verification option not found.");
      }

      // Wait for code input field and prompt user
      await persistentPage.waitForSelector('input[name="totpPin"], input[type="tel"]', { visible: true });
      const code = await promptForCode();
      await persistentPage.type('input[name="totpPin"], input[type="tel"]', code);
      await persistentPage.click("#totpNext, #submitChallenge"); // Adjust selector as needed
      await persistentPage.waitForNavigation({ waitUntil: "domcontentloaded" });
    } else {
      // Proceed with password login if no verification
      await persistentPage.type("input[name='Passwd']", process.env.GOOGLE_PASSWORD || "");
      await persistentPage.click("#passwordNext");
      await persistentPage.waitForNavigation({ waitUntil: "domcontentloaded" });
    }

    console.log("Logged in successfully");
  } catch (err) {
    console.error("Failed to initialize browser:", err);
    if (persistentPage) await persistentPage.close();
    if (browser) await browser.close();
    browser = null;
    persistentPage = null;
    throw err;
  }
}

// Route handler reusing the page and caching responses
const fetchFormHandler: RequestHandler = async (req: Request, res: Response) => {
  const { url } = req.query;

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "URL is required and must be a string" });
    return;
  }

  if (!browser || !persistentPage) {
    res.status(500).json({ error: "Browser not initialized" });
    return;
  }

  try {
    // Check cache first
    if (formCache.has(url)) {
      console.log(`Cache hit for ${url}`);
      res.send(formCache.get(url));
      return;
    }

    // Fetch form and cache it
    await persistentPage.goto(url, { waitUntil: "domcontentloaded" });
    const html = await persistentPage.content();
    formCache.set(url, html); // Cache the response
    console.log(`Fetched and cached ${url}`);
    res.send(html);
  } catch (err) {
    console.error("Error fetching form:", err);
    res.status(500).json({ error: "Failed to fetch form" });
  }
};

app.get("/fetch-form", fetchFormHandler);

// Start server and initialize browser
async function startServer() {
  await initializeBrowser();
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

// Handle server shutdown
async function shutdown() {
  console.log("Shutting down server...");
  if (persistentPage) await persistentPage.close();
  if (browser) await browser.close();
  rl.close(); // Close readline interface
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start the server
startServer().catch((err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});
