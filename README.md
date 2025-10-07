### WARNING: This repository may save data to disk. If you make this repository public, others could access saved data. Keep the repo private if it contains any sensitive information.

## Beginner-friendly guide: how to get this project running (step-by-step)

This README explains how to get the site running locally using GitHub (web), Codespaces, or your local machine. It assumes you are new to GitHub. If you already know Git/GitHub, you can skim the introductory sections.

Table of contents
- What you'll need
- Quick overview of the files
- Option A: Use GitHub Codespaces (recommended for fastest setup)
- Option B: Use your local machine
- How to stop the server and free the port
- Where to get help

What you'll need
- A GitHub account (free) if you want to use Codespaces or fork the repo.
- Node.js and npm installed if you're running locally. Node 18+ is recommended.
- A terminal (macOS/Linux Terminal, Windows PowerShell or Git Bash).

Quick overview of the files
- `server.js` - simple Node.js server that runs the site.
- `public/index.html` - the static front-end page.
- `package.json` - project metadata and scripts (used by npm).
- `install-deps.sh` - helper script that installs dependencies.

## Option A — Use GitHub Codespaces (fastest, no local installs)
### 1. Open this repository on GitHub in your web browser.

### 2. Fork the repository (creates a personal copy under your account):
Click the "Fork" button near the top-right of the GitHub page.

Choose your account and confirm. This
copies the repo into your GitHub account.

Why fork? A fork makes your own editable copy so you can experiment without changing the original project.

### 3. Open a Codespace (runs the project in the cloud):
On your fork's GitHub page, click the green "Code" button.

Choose the "Codespaces" tab and click the "+" (New codespace) button.

Wait for the Codespace to start. It opens a VS Code-like editor in the browser.

### 4. Run the setup script inside the Codespace terminal (if present):


Make the setup script executable (only needed once)
```bash
chmod +x install-deps.sh
```
Run the setup script which installs dependencies
```bash
./install-deps.sh
```

### 5. Start the server:

```bash
npm start
```

### 6. Preview the site:
- In the Codespaces environment, open the "Ports" panel (bottom or left) and find port 3000. Click "Open in Browser" or "Preview".

## Option B — Run locally on your computer
1. Clone your fork (or the original repo) to your machine. If you forked the repo, click the green "Code" button on GitHub and copy the clone URL, then run:


Replace <your-git-url> with the HTTPS URL from GitHub (copy from Code button)
```bash
git clone <your-git-url>
cd bbpa
```

2. Install dependencies (make script executable and run it):

```bash
chmod +x install-deps.sh
./install-deps.sh
```

If you prefer to install manually instead of using the script:

```bash
npm install
```

3. Start the server:

```bash
npm start
```

4. Open your browser and go to:

```
http://localhost:3000
```

How to stop the server and free port 3000
- In the terminal where the server is running, press Ctrl+C to stop it.
- If the server doesn't stop or port 3000 is still taken, find the process and kill it:


Show process using port 3000
```bash
sudo lsof -i :3000
```
Suppose the PID shown is 1234, kill it
```bash
kill 1234
```

Helpful tips and troubleshooting
- If `npm start` fails, look at the error message in the terminal. Usually it tells you which dependency or file is missing.
- Make sure Node.js is installed if running locally: `node -v` and `npm -v` should print versions.
- If a command returns "permission denied", try `chmod +x <script>` or run with `./<script>` from the project root.
- Sometimes just running `npm install` can fix some errors. 

Where to get help
- If you made this project from a course or a friend, ask them first.
- For Git/GitHub questions, see: https://docs.github.com/en/get-started/quickstart
- Message me on Discord `SmartName72`

— small safety reminder
- This repo may store data on disk (saved locally on repo). Do not make the repository public if it includes any private or sensitive data.
