# AI Voice Assistant for Outlook

Speak an email in English. The text shows up in a side pane, where you can review and edit it, and it goes into your email only when you click **Insert into Email**.

- **Speech-to-text:** OpenAI. You paste your own API key in the add-in's Settings.
- **Cleanup:** built-in rules remove fillers (um, uh, ah) and stutters and fix capitalization and punctuation. This needs no extra AI.
- **Works in:** new Outlook for Windows and Outlook on the web. Classic Outlook is not supported.

## 1. Put the files on GitHub Pages (about 5 minutes)

1. Sign in at github.com, then select **New repository**. Name it `outlook-voice-assistant`, set it to **Public**, and select **Create repository**.
2. Select **uploading an existing file**. Drag in **everything in this folder**, including the `assets` folder, then select **Commit changes**.
3. Go to **Settings › Pages**. Under *Branch*, choose `main` and `/ (root)`, then select **Save**.
4. Wait about a minute. Your site will be at `https://YOUR-USERNAME.github.io/outlook-voice-assistant/`.

## 2. Get your manifest

Open your site address in Edge or Chrome and select **Download manifest.xml**. The page fills in your own web address automatically.

## 3. Add it to Outlook

1. Open **https://aka.ms/olksideload**. This works from new Outlook or Outlook on the web.
2. Go to **My add-ins › Custom Addins › Add a custom add-in › Add from File…** and choose `manifest.xml`.
3. If that option is missing, your organization blocks custom add-ins. Ask IT to deploy the manifest for you.

## 4. Use it

1. Open a new email or a reply. On the ribbon (or under **Apps**), select **Voice Assistant**.
2. Select the gear icon, paste your OpenAI API key (from platform.openai.com › API keys), and select **Save**. Select **Test key** to check it.
3. Select **Start recording**. Choose **Allow** when Outlook asks for the microphone. The first time, the pane reloads after you allow it.
4. Speak. Your words appear in grey under **Hearing**, then move up into **Your text** once each phrase is polished.
5. Pause, resume or stop whenever you like. Edit the text freely: new speech is always added after your edits, never over them.
6. Select **Insert into Email**. The text goes in at your cursor (or at the top of the message if no cursor is set). Nothing is ever sent. To undo, press Ctrl+Z in the message.

## Privacy

- Audio goes from your computer straight to api.openai.com over HTTPS.
- The add-in doesn't save recordings or transcripts.
- Your API key is stored only in this add-in on your computer. Use a project key with a spending limit.
- Check with IT/security before you dictate sensitive or CUI content.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Microphone blocked" | Select **Try again** and choose **Allow**. Also check Windows **Settings › Privacy & security › Microphone**. |
| "OpenAI rejected the API key" | Paste a new key in Settings, select **Save**, then **Retry**. |
| "OpenAI usage limit reached" | Add credit at platform.openai.com › Billing. |
| Text arrives slowly | Pick `gpt-4o-mini-transcribe` in Settings. Short pauses between phrases help. |
| Button missing in Outlook | Make sure you're in a compose window (new message or reply). Remove and re-add the manifest if needed. |

## Updating

Edit the files in your GitHub repository. Outlook picks up the changes the next time you open the pane. You don't need a new manifest unless the web address changes.
