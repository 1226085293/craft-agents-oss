/**
 * Event shape the WhatsApp plugin reports while pairing.
 *
 * Kept here because the host renders the QR / pairing-code UI and therefore
 * needs the vocabulary; the behaviour stays in the plugin program.
 */
export type WhatsAppEvent =
  | { type: 'qr'; qr: string }
  | { type: 'pairing_code'; code: string }
  | { type: 'connected'; jid?: string; name?: string }
  | { type: 'disconnected'; loggedOut: boolean; reason?: string }
  | { type: 'unavailable'; reason: string; message: string }
  | { type: 'error'; message: string }
