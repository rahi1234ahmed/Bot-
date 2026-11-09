# SlotWatch

Alert service for VFS appointment slots. Users sign up on the website, you mark a
slot as open in the admin panel, matching users are notified and book themselves
on the official VFS site. The backend never contacts VFS and never books anything.

## Run
1. Install Node.js 18+ (20.12+ auto-loads .env; otherwise export the variables).
2. `cp .env.example .env` and fill it in (change ADMIN_PASS!).
3. `npm install`
4. `npm start` then open http://localhost:3000 (site) and /admin (panel).

## Notes
- Telegram: users must message your bot first and use their numeric chat ID as contact.
- WhatsApp needs the WhatsApp Business API; not included.
- Data is stored in data.json. Put the app behind HTTPS before going live.
- You are responsible for complying with VFS terms and privacy laws for stored contacts.

## Proxy setup
- **Behind a reverse proxy** (nginx, Caddy, Cloudflare, Render...): set `TRUST_PROXY=1`
  so rate limiting uses each visitor's real IP. Make sure your proxy sends `X-Forwarded-For`.
- **Outgoing proxy** (only if the server cannot reach Telegram/SMTP directly): set
  `OUTBOUND_PROXY=http://user:pass@host:port`. Used for Telegram and email sending only.
- After changing package.json run `npm install` again (adds `undici`).
