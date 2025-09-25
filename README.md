# SET REPO/CODESPACE TO PRIVATE IF YOU USE THIS. ALL SAVED DATA IS SAVED LOCALLY AND ATTACKERS HAVE EASY ACCESS IF YOU LEAVE THIS PUBLIC!!!!

## How to Set Up and Access Your Site

## Click the green **code** button, codespace, then hit the + icon

### 1. Make the Setup Script Executable

Before running the setup script, give it permission to execute:

```bash
chmod +x setup-all.sh
```

### 2. Run the Setup Script

Start the setup process:

```bash
./setup-all.sh
```

This will install dependencies and prepare your project.

### 3. Start the Server

Launch your server with:

```bash
npm start
```

This will start your site, usually on port 3000.

### 4. Preview Your Site

- In Visual Studio Code (or Codespaces), open the **Ports** panel.
- Find port `3000` in the list.
- Click **Preview** to open your site in the browser.

Alternatively, you can run:

```bash
"$BROWSER" http://localhost:3000
```

to open the site in your default browser.

---

## How to Close the Port

When you’re done, you can stop the server by pressing `Ctrl+C` in the terminal where it’s running.

If port 3000 is still in use (for example, if the server didn’t shut down properly), you can free it up:

### 1. Find the Process Using Port 3000

```bash
sudo lsof -i :3000
```

This shows the process ID (PID) using port 3000.
what it may look like:

@User ➜ /workspaces/codespaces-blank $ sudo lsof -i :3000

COMMAND  PID USER        FD   TYPE  DEVICE SIZE/OFF NODE NAME

node    1234 codespace   28u  IPv4  54321  0t0      TCP *:3000

### 2. Kill the Process

Replace `PID` with the actual number you see:

```bash
kill PID
```

For example, if the PID is `1234`:

```bash
kill 1234
```

Now port 3000 is free for your server to use again.

---

**Tip:**
DM `Hutlaw` on discord for questions
