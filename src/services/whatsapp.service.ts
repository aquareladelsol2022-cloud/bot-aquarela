import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import os from 'os';
import pino from 'pino';

// Export the socket instance so index.ts can use it
export let sock: any = null;

export const initWhatsAppClient = async (onMessageReceived: (msg: any) => Promise<void>) => {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }) as any,
        browser: ['La Aquarela Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', (update: any) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n=========================================');
            console.log('ESCANEA ESTE CÓDIGO QR PARA INICIAR SESIÓN EN WHATSAPP:');
            qrcode.generate(qr, { small: true });
            console.log('\nSi el código de arriba se ve cortado o con líneas, haz clic en este enlace para verlo perfecto:');
            console.log('https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(qr));
            console.log('=========================================\n');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Reconectando:', shouldReconnect);
            if (shouldReconnect) {
                initWhatsAppClient(onMessageReceived);
            }
        } else if (connection === 'open') {
            console.log('¡Cliente de WhatsApp Web conectado y listo! (Baileys)');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Listen to messages
    sock.ev.on('messages.upsert', async (m: any) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (!msg.key.fromMe && msg.message) {
                    await onMessageReceived(msg);
                }
            }
        }
    });
};

/**
 * Sends a text message back to the user via WhatsApp
 */
export const sendWhatsAppMessage = async (to: string, body: string) => {
    try {
        const chatId = to.includes('@s.whatsapp.net') ? to : `${to.replace('@c.us', '')}@s.whatsapp.net`;
        await sock.sendMessage(chatId, { text: body });
        console.log(`Mensaje enviado a ${to}`);
    } catch (error: any) {
        console.error('Error enviando mensaje WhatsApp:', error);
        fs.appendFileSync('whatsapp_error.log', new Date().toISOString() + ' - Error sending text message: ' + JSON.stringify(error) + '\n');
    }
};

/**
 * Downloads a media file from an incoming message
 */
export const downloadWhatsAppMedia = async (msg: any): Promise<string | null> => {
    try {
        const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            { },
            { logger: pino({ level: 'silent' }) as any }
        );
        
        if (!buffer) return null;
        
        // Determine extension based on message type
        let extension = 'bin';
        const messageType = Object.keys(msg.message)[0];
        
        if (messageType === 'audioMessage') extension = 'ogg';
        else if (messageType === 'videoMessage') extension = 'mp4';
        else if (messageType === 'imageMessage') extension = 'jpg';
        else if (messageType === 'documentMessage') extension = 'pdf';
        
        const tempFilePath = path.join(os.tmpdir(), `whatsapp_media_${Date.now()}.${extension}`);
        fs.writeFileSync(tempFilePath, buffer);
        return tempFilePath;
    } catch (error: any) {
        console.error('Error downloading media:', error);
        return null;
    }
};
