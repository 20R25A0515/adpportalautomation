const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// ADP VISTA SELECTORS (hardcoded - discovered via shadow DOM inspection)
// dotenv truncates values at '#' characters, so we define them here.
// ============================================================
const SELECTORS = {
  // Step 1: Username
  USERNAME_INPUT: 'sdf-input#login-form_username input',
  NEXT_BUTTON: 'sdf-button#verifUseridBtn',

  // Step 2: Password
  PASSWORD_INPUT: 'sdf-input#login-form_password input',
  SIGN_IN_BUTTON: 'sdf-button#signBtn',

  // Step 3: MFA / OTP  (we'll discover these dynamically)
  // These are best-guesses; the MFA page elements will be inspected at runtime.
  MFA_EMAIL_OPTION: [
    'sdf-radio[value="email"]',
    'label:has-text("Email")',
    'text=Email'
  ],
  MFA_SEND_BUTTON: [
    'sdf-button:has-text("Send")',
    'sdf-button:has-text("Continue")',
    'sdf-button:has-text("Submit")'
  ],
  MFA_OTP_INPUT: [
    'sdf-input#otp input',
    'sdf-input[label*="code"] input',
    'sdf-input[label*="Code"] input',
    'input[name="otp"]',
    'input#otp'
  ],
  MFA_VERIFY_BUTTON: [
    'sdf-button:has-text("Verify")',
    'sdf-button:has-text("Submit")',
    'sdf-button:has-text("Sign in")'
  ],

  // Step 4: Dashboard navigation
  // "Me" in the sidebar has an arrow/chevron that must be clicked to expand
  ME_MENU: [
    'text="Me"',
    'a:text-is("Me")',
    'span:text-is("Me")',
    ':text-is("Me")',
    'li:has-text("Me") >> visible=true',
    'text=Me >> nth=0'
  ],
  TIME_ATTENDANCE: [
    'text="Time & Attendance"',
    'a:text-is("Time & Attendance")',
    'text="Time and Attendance"',
    'a:has-text("Time & Attendance")',
    'a:has-text("Time and Attendance")',
    'span:has-text("Time & Attendance")',
    'text=Time & Attendance',
    'text=Time and Attendance'
  ],

  // Step 5: Punch actions (SecureTime portal)
  PUNCH_IN: [
    'button:has-text("Punch In")',
    'button:has-text("PUNCH IN")',
    'input[value="Punch In"]',
    '#punchIn'
  ],
  PUNCH_OUT: [
    'button:has-text("Punch Out")',
    'button:has-text("PUNCH OUT")',
    'input[value="Punch Out"]',
    '#punchOut'
  ]
};

// Global state
let state = 'idle'; // idle | logging_in | awaiting_otp | processing_punch | success | error
let logs = [];
let screenshotPath = null;
let errorMessage = null;
let isRunning = false;
let activeBrowser = null;
let otpResolve = null;
let currentCredentials = null; // { userId, password } — set per-run from the UI

function addLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  const logMsg = `[${timestamp}] ${message}`;
  logs.push(logMsg);
  console.log(logMsg);
}

/**
 * Race multiple selectors IN PARALLEL. Returns the first one found visible.
 * Accepts either a single selector string or an array of selectors.
 */
async function findFirst(page, selectors, timeout = 15000) {
  const selectorList = Array.isArray(selectors) ? selectors : [selectors];
  addLog(`Searching for element: ${selectorList.join(' | ')}`);

  // Race all selectors in parallel — first match wins instantly
  const result = await Promise.any(
    selectorList.map(async (sel) => {
      await page.waitForSelector(sel, { state: 'visible', timeout });
      return sel;
    })
  ).catch(() => null);

  if (!result) {
    throw new Error(`Could not find any of: ${selectorList.join(', ')}`);
  }

  addLog(`  ✓ Found: ${result}`);
  return result;
}

/**
 * Wait for OTP from either the web UI or the terminal console.
 */
function waitForOtp() {
  return new Promise((resolve) => {
    let resolved = false;
    let rl;

    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      try { if (rl) rl.close(); } catch (e) {}
      resolve(value);
    };

    // Expose to the HTTP /api/otp endpoint
    otpResolve = finish;

    // Also prompt in the terminal
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('\n==================================================');
    console.log(' OTP REQUIRED: Enter the code here or in the Web UI');
    console.log(' Web UI: http://localhost:' + PORT);
    console.log('==================================================\n');

    rl.question('OTP Code > ', (answer) => {
      const code = answer.trim();
      if (code) {
        addLog(`OTP entered via terminal.`);
        finish(code);
      }
    });
  });
}

// ============================================================
// PUNCH + SCREENSHOT HELPER
// ============================================================
async function performPunch(secureTimePage, action) {
  const punchSelectors = action === 'in' ? SELECTORS.PUNCH_IN : SELECTORS.PUNCH_OUT;
  const punchLabel = action === 'in' ? 'Punch IN' : 'Punch OUT';
  addLog(`Performing ${punchLabel}...`);

  const punchSel = await findFirst(secureTimePage, punchSelectors);
  await secureTimePage.click(punchSel);
  addLog(`${punchLabel} button clicked!`);

  // Wait for the location permission to be auto-granted and the success popup to appear
  addLog('Waiting for location access and success confirmation popup...');
  
  // Try to detect the success popup text
  let successFound = false;
  try {
    // Wait up to 20 seconds for the success popup to appear
    await secureTimePage.waitForFunction(() => {
      const bodyText = document.body.innerText.toLowerCase();
      return bodyText.includes('success') || 
             bodyText.includes('punch in success') || 
             bodyText.includes('punch out success') ||
             bodyText.includes('punched in') ||
             bodyText.includes('punched out') ||
             bodyText.includes('recorded');
    }, { timeout: 20000 });
    successFound = true;
    addLog('Success confirmation detected!');
  } catch (e) {
    addLog('Timed out waiting for success text. Taking screenshot of current state...');
  }

  // Extra wait for popup rendering to fully complete
  await secureTimePage.waitForTimeout(2000);

  const screenshotDir = path.join(__dirname, 'public', 'screenshots');
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  const filename = `punch_${action}_${Date.now()}.png`;
  const fullPath = path.join(screenshotDir, filename);

  addLog('Capturing screenshot...');
  await secureTimePage.screenshot({ path: fullPath, fullPage: true });

  screenshotPath = `/screenshots/${filename}`;
  state = 'success';
  addLog(` ${punchLabel} completed successfully!`);
}

// ============================================================
// MAIN AUTOMATION
// ============================================================
async function runAutomation(action, userId, password) {
  isRunning = true;
  state = 'logging_in';
  logs = [];
  screenshotPath = null;
  errorMessage = null;
  currentCredentials = { userId, password };

  addLog('Launching Chromium browser...');

  try {
    const isProduction = process.env.NODE_ENV === 'production';
    activeBrowser = await chromium.launch({
      headless: isProduction,
      args: [
        '--disable-blink-features=AutomationControlled',
        ...(isProduction ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : [])
      ]
    });

    const context = await activeBrowser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      permissions: ['geolocation'],
      geolocation: { latitude: 17.385044, longitude: 78.486671 } // Hyderabad, India
    });
    const page = await context.newPage();

    // ------- STEP 1: Navigate to login page -------
    const loginUrl = process.env.PORTAL_LOGIN_URL;
    addLog(`Navigating to login page...`);
    await page.goto(loginUrl, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(2000); // let SDF web-components hydrate

    // ------- STEP 2: Enter Username -------
    addLog('Entering User ID...');
    const usernameSelector = await findFirst(page, SELECTORS.USERNAME_INPUT);
    await page.fill(usernameSelector, currentCredentials.userId);
    addLog(`User ID entered: ${currentCredentials.userId}`);

    // Click Next
    addLog('Clicking Next...');
    const nextBtnSelector = await findFirst(page, SELECTORS.NEXT_BUTTON);
    await page.click(nextBtnSelector);
    await page.waitForTimeout(500); // minimal delay, rely on findFirst next

    // ------- STEP 3: Enter Password -------
    addLog('Entering Password...');
    const passwordSelector = await findFirst(page, SELECTORS.PASSWORD_INPUT);
    await page.fill(passwordSelector, currentCredentials.password);
    addLog('Password entered.');

    // Click Sign In
    addLog('Clicking Sign In...');
    const signInSelector = await findFirst(page, SELECTORS.SIGN_IN_BUTTON);
    await page.click(signInSelector);
    addLog('Sign In clicked. Waiting for response...');
    await page.waitForTimeout(500); // minimal delay
    // ------- STEP 4: MFA / OTP Handling -------
    addLog('Checking for MFA/OTP challenge...');

    let mfaDetected = false;
    let otpPromise = null;

    // Try to find an email OTP option
    try {
      const emailOptionSel = await findFirst(page, SELECTORS.MFA_EMAIL_OPTION, 5000);
      if (emailOptionSel) {
        addLog('MFA detected! Selecting Email OTP...');
        await page.click(emailOptionSel);
        mfaDetected = true;
        await page.waitForTimeout(500);

        // Click Send / Continue button
        try {
          const sendBtnSel = await findFirst(page, SELECTORS.MFA_SEND_BUTTON, 5000);
          await page.click(sendBtnSel);
          addLog('OTP send button clicked.');
          await page.waitForTimeout(500);
        } catch (e) {
          addLog('No explicit send button found; OTP may have been sent automatically.');
        }

        // POP UI MODAL IMMEDIATELY
        addLog('Triggering UI modal for OTP input...');
        state = 'awaiting_otp';
        otpPromise = waitForOtp();
      }
    } catch (e) {
      addLog('No MFA email option screen detected.');
    }

    // Now look for OTP input field
    try {
      const otpInputSel = await findFirst(page, SELECTORS.MFA_OTP_INPUT, 8000);
      if (otpInputSel) {
        if (!mfaDetected) {
          mfaDetected = true;
          addLog('OTP input field found directly. Triggering UI modal...');
          state = 'awaiting_otp';
          otpPromise = waitForOtp();
        } else {
          addLog('OTP input field is now ready.');
        }

        const otp = await otpPromise;
        addLog('Submitting OTP...');

        await page.fill(otpInputSel, otp);

        // Click verify / submit
        try {
          const verifyBtnSel = await findFirst(page, SELECTORS.MFA_VERIFY_BUTTON, 5000);
          await page.click(verifyBtnSel);
        } catch (e) {
          // Try pressing Enter as fallback
          await page.keyboard.press('Enter');
        }

        addLog('OTP submitted. Waiting for dashboard redirect...');
        await page.waitForTimeout(5000);
      }
    } catch (e) {
      if (!mfaDetected) {
        addLog('No OTP input detected. Proceeding to dashboard...');
      }
    }

    // ------- STEP 5: Wait for Dashboard -------
    addLog('Waiting for dashboard page...');
    try {
      await page.waitForURL(
        url => url.includes('/dashboard') || url.includes('/ess/'),
        { timeout: 45000 }
      );
    } catch (e) {
      // If URL check fails, just check current URL
      const currentUrl = page.url();
      addLog(`Current URL: ${currentUrl}`);
      if (!currentUrl.includes('/dashboard') && !currentUrl.includes('/ess/')) {
        throw new Error(`Did not reach dashboard. Current URL: ${currentUrl}`);
      }
    }
    addLog('Dashboard reached!');

    state = 'processing_punch';

    // ------- STEP 6: Navigate to Time & Attendance -------
    // Wait for dashboard to fully render
    addLog('Waiting for dashboard to fully load...');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Click the "Me" arrow/expander to open the submenu
    addLog('Clicking "Me" menu arrow to expand submenu...');
    const meSelector = await findFirst(page, SELECTORS.ME_MENU);
    await page.click(meSelector);
    await page.waitForTimeout(2000);

    // Now find and click "Time & Attendance"
    addLog('Looking for "Time & Attendance" in expanded menu...');
    const timeAttSel = await findFirst(page, SELECTORS.TIME_ATTENDANCE);

    // Prepare to catch new tab (SecureTime opens in a new tab)
    const newPagePromise = context.waitForEvent('page', { timeout: 30000 });
    await page.click(timeAttSel);

    addLog('Waiting for SecureTime portal tab...');
    const secureTimePage = await newPagePromise;
    await secureTimePage.waitForLoadState('networkidle');
    addLog('SecureTime portal loaded!');
    await secureTimePage.waitForTimeout(3000);

    await performPunch(secureTimePage, action);

  } catch (error) {
    addLog(` Error: ${error.message}`);
    state = 'error';
    errorMessage = error.message;
  } finally {
    if (activeBrowser) {
      addLog('Closing browser...');
      await activeBrowser.close();
      activeBrowser = null;
    }
    isRunning = false;
    otpResolve = null;
    currentCredentials = null;
  }
}

// REST API ENDPOINTS

app.get('/api/status', (req, res) => {
  res.json({ state, logs, screenshotPath, errorMessage, isRunning });
});

app.post('/api/punch', (req, res) => {
  const { action, userId, password } = req.body;
  if (!['in', 'out'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action. Must be "in" or "out"' });
  }
  if (!userId || !password) {
    return res.status(400).json({ error: 'User ID and Password are required' });
  }
  if (isRunning) {
    return res.status(400).json({ error: 'Automation is already running' });
  }

  runAutomation(action, userId, password);
  res.json({ success: true, message: `Started Punch ${action.toUpperCase()}` });
});

app.post('/api/otp', (req, res) => {
  const { otp } = req.body;
  if (!otp) {
    return res.status(400).json({ error: 'OTP code is required' });
  }
  if (state !== 'awaiting_otp' || !otpResolve) {
    return res.status(400).json({ error: 'Not waiting for OTP' });
  }

  otpResolve(otp);
  res.json({ success: true, message: 'OTP submitted' });
});

app.post('/api/cancel', async (req, res) => {
  if (!isRunning && state === 'idle') {
    return res.status(400).json({ error: 'Nothing running' });
  }

  addLog('Cancelling automation...');
  if (activeBrowser) {
    await activeBrowser.close().catch(() => {});
    activeBrowser = null;
  }
  if (otpResolve) {
    otpResolve('');
    otpResolve = null;
  }
  isRunning = false;
  state = 'idle';
  res.json({ success: true, message: 'Cancelled' });
});

app.listen(PORT, () => {
  console.log(`\n Server running at http://localhost:${PORT}`);
  console.log(`   Credentials: Dynamic (entered via Web UI)`);
  console.log(`   Login URL loaded: ${process.env.PORTAL_LOGIN_URL ? 'Yes' : 'No'}\n`);
});
