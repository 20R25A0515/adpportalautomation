# 🕒 SecureTime Portal Automation

A premium browser automation dashboard for ADP Vista portal attendance check-in/check-out.

## Features

- **Dynamic Credentials** — Enter your Portal User ID and Password directly in the Web UI (never stored on disk)
- **One-click Punch In/Out** — Automates the full login → MFA → navigation → punch workflow
- **MFA/OTP Support** — Prompts for OTP code via modal (also accepts input from the terminal)
- **Live Execution Logs** — Real-time log stream of every automation step
- **Screenshot Verification** — Captures and displays a screenshot of the successful punch
- **Cancel Anytime** — Abort the running automation with a single click

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- Playwright browsers installed

## Setup

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd portal-automation-app
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Install Playwright browsers**
   ```bash
   npx playwright install chromium
   ```

4. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env if you need to change the PORT or portal URLs
   ```

5. **Start the server**
   ```bash
   npm start
   ```

6. **Open the dashboard**
   Navigate to `http://localhost:3000` in your browser.

## Usage

1. Enter your **Portal User ID** and **Password** in the credentials section
2. Click **Punch In** or **Punch Out**
3. If MFA is required, enter the OTP code in the modal that appears
4. Wait for the automation to complete — a verification screenshot will be shown

## Tech Stack

- **Backend**: Node.js + Express
- **Automation**: Playwright (Chromium)
- **Frontend**: Vanilla HTML/CSS/JS with glassmorphism design

## License

MIT
