# Pool Pal

Pool Pal is a mobile-first AI chat assistant for pool technicians.

The interface is intentionally simple: a central chat screen, a sidebar for past conversations, and settings for company procedures, chemical targets, vehicle stock, and model choice.

## Run Locally With OpenAI

1. Create a local `.env` file from `.env.example`.
2. Add your OpenAI API key:

```sh
OPENAI_API_KEY="your_openai_api_key_here"
OPENAI_MODEL="gpt-5.4-mini"
PORT=4173
```

3. Start the app:

```sh
npm start
```

If `npm` is not available but Node is installed, run:

```sh
node server.js
```

4. Open:

```sh
http://localhost:4173
```

Do not put your OpenAI API key in `index.html`. The browser talks to the local server, and the local server talks to OpenAI.

## What It Does

- Real AI guidance through the OpenAI Responses API
- ChatGPT-style home screen and conversation flow
- Sidebar with past conversations and settings
- Company-configurable procedures, targets, stock notes, and knowledge
- Pool technician system prompt focused on practical diagnosis, chemical guidance, escalation, and field-friendly wording
- Local browser storage for past conversations and settings

## Files

- `index.html` is the app interface
- `server.js` is the local OpenAI API bridge
- `.env.example` shows the required environment variables
- `package.json` provides `npm start`
