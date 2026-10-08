// The few Telegram Bot API calls the monitoring needs.

export type IncomingMessage = {
  chatId: string;
  text: string;
};

export class Telegram {
  private offset = 0;

  constructor(private token: string) {}

  private async call<T>(method: string, params: object, timeoutMs = 15_000): Promise<T> {
    // The URL holds the token: errors must not include it.
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json()) as { ok: boolean; result: T; description?: string };

    if (!body.ok) {
      throw new Error(`Telegram ${method}: ${body.description ?? response.status}`);
    }

    return body.result;
  }

  async send(chatId: string, html: string, options: { silent?: boolean } = {}) {
    await this.call("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_notification: options.silent ?? false,
      link_preview_options: { is_disabled: true },
    });
  }

  // Waits up to `seconds` for new messages to the bot.
  async receive(seconds = 50): Promise<IncomingMessage[]> {
    const updates = await this.call<
      { update_id: number; message?: { chat: { id: number }; text?: string } }[]
    >("getUpdates", { offset: this.offset, timeout: seconds, allowed_updates: ["message"] }, (seconds + 15) * 1000);

    const messages: IncomingMessage[] = [];

    for (const update of updates) {
      this.offset = update.update_id + 1;

      if (update.message?.text) {
        messages.push({ chatId: String(update.message.chat.id), text: update.message.text });
      }
    }

    return messages;
  }
}
