# Wired host setup (company-internal)

Goal: one always-on PC on **wired LAN**, starting the server at boot and restarting it if it crashes.

## 1. Pick the host
- A desktop/mini-PC on Ethernet (not Wi-Fi), never sleeping, ideally on a UPS.
- Ask IT for **a reserved IP** (DHCP reservation) and, if possible, a **DNS name** such as `sort.<company-domain>`.
  A fixed name/IP is what keeps the phone-camera certificate valid; Wi-Fi laptops change IP and break it.

## 2. Install once
1. Node.js 20+ LTS (nodejs.org) and Git for Windows (git-scm.com; it also provides `openssl`).
2. `git clone https://github.com/ashutoshsingh-hue/Bermuda-Inventory-Consolidation.git`
   (private repo: sign in when asked, or use a personal access token).
3. Copy the live data across (data is NOT in git). On the OLD machine **stop the server first**, then copy
   `data\bermuda.db` (and `bermuda.db-wal` / `-shm` if present) into the new `data\` folder.
   Also copy `backups\` if you want history.

## 3. Run the setup script
Admin PowerShell in the project folder:
```
powershell -ExecutionPolicy Bypass -File deploy\setup-host.ps1
```
It installs dependencies, opens port 8080, makes the HTTPS certificate for this PC's name + IPs,
registers the `BermudaSortStation` startup task (SYSTEM, restart every minute on failure) and disables sleep.

## 4. Check
- From another PC: `Test-NetConnection <host> -Port 8080` -> `TcpTestSucceeded : True`.
- Reboot the host once; the site must come back with nobody logged in.
- Phones: `https://<host>:8080/station/`, accept the certificate warning once per phone.
  To remove the warning, IT can issue a certificate from the company CA: replace `certs\key.pem` / `certs\cert.pem` and restart.

## Operations
- Restart: `Stop-ScheduledTask BermudaSortStation; Start-ScheduledTask BermudaSortStation`
- Logs: `server.log` in the project folder.
- Update: `git pull`, `npm install --omit=dev`, restart the task. Run `npm test` first if code changed (needs dev deps: `npm install`).
- Backups: automatic nightly 22:15 and before every Clear/Remove/Restore (newest 2 kept). Copy `backups\` off the PC regularly.
- If other PCs still cannot connect while `Test-NetConnection` fails: a domain Group Policy is overriding the firewall rule
  or the network isolates clients. Ask IT to allow inbound TCP 8080 to this host.
