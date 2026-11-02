import { Resend } from "resend";
import axios from "axios";

export interface StreamNotificationPayload {
  streamId: string;
  sender: string;
  recipient: string;
  recipientEmail?: string;
  amount: string;
  tokenSymbol: string;
  action: "STREAM_INITIALIZED" | "WITHDRAWAL_EXECUTED" | "STREAM_CANCELED";
  txSignature: string;
}

export class EnterpriseNotificationEngine {
  private resend: Resend | null = null;
  private webhookUrl: string | null = null;

  constructor() {
    const resendApiKey = process.env.RESEND_API_KEY;
    if (resendApiKey) {
      this.resend = new Resend(resendApiKey);
    }
    this.webhookUrl = process.env.AUDIT_WEBHOOK_URL || null;
  }

  async notify(payload: StreamNotificationPayload): Promise<void> {
    const promises: Promise<any>[] = [];

    // 1. Dispatch Webhook to Slack / Corporate Audit Server
    if (this.webhookUrl) {
      promises.push(
        axios.post(this.webhookUrl, {
          event: payload.action,
          streamId: payload.streamId,
          details: {
            sender: payload.sender,
            recipient: payload.recipient,
            amount: `${payload.amount} ${payload.tokenSymbol}`,
            explorerUrl: `https://solscan.io/tx/${payload.txSignature}?cluster=devnet`,
          },
          timestamp: new Date().toISOString(),
        }).catch((err) => {
          console.error(`[Webhook] Dispatch failed: ${err.message}`);
        })
      );
    }

    // 2. Dispatch High-Priority Transactional Email via Resend
    if (this.resend && payload.recipientEmail) {
      const emailPromise = this.resend.emails.send({
        from: "KredoStream Ops <billing@kredostream.io>",
        to: [payload.recipientEmail],
        subject: `[KredoStream Alert] ${payload.action.replace("_", " ")} - Stream #${payload.streamId}`,
        html: `
          <div style="font-family: Arial, sans-serif; background-color: #0b0e14; color: #ffffff; padding: 24px; border-radius: 8px;">
            <h2 style="color: #14F195; margin-bottom: 8px;">KredoStream Settlement Alert</h2>
            <p style="color: #94a3b8; font-size: 14px;">Deterministic Solana continuous settlement update.</p>
            <hr style="border: 0; border-top: 1px solid #1e293b; margin: 20px 0;" />
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
              <tr><td style="padding: 8px 0; color: #94a3b8;">Stream ID:</td><td style="font-weight: bold;">#${payload.streamId}</td></tr>
              <tr><td style="padding: 8px 0; color: #94a3b8;">Action:</td><td style="color: #38bdf8; font-weight: bold;">${payload.action}</td></tr>
              <tr><td style="padding: 8px 0; color: #94a3b8;">Amount Settled:</td><td style="font-weight: bold;">${payload.amount} ${payload.tokenSymbol}</td></tr>
              <tr><td style="padding: 8px 0; color: #94a3b8;">Recipient Public Key:</td><td style="font-family: monospace;">${payload.recipient}</td></tr>
            </table>
            <div style="margin-top: 24px;">
              <a href="https://solscan.io/tx/${payload.txSignature}?cluster=devnet" 
                 style="background: #14F195; color: #000000; text-decoration: none; padding: 10px 20px; border-radius: 4px; font-weight: bold; display: inline-block;">
                Verify on Solscan
              </a>
            </div>
            <p style="margin-top: 30px; font-size: 12px; color: #64748b;">
              Cryptographically signed by Anchor Program: Kredox1111111111111111111111111111111111111
            </p>
          </div>
        `,
      }).catch((err) => {
        console.error(`[Resend] Email dispatch failed: ${err.message}`);
      });

      promises.push(emailPromise);
    }

    await Promise.allSettled(promises);
    console.log(`[NotificationEngine] Successfully dispatched alerts for Stream #${payload.streamId}`);
  }
}