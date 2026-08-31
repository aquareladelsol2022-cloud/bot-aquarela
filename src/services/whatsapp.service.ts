import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const whatsappClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

export const initWhatsAppClient = () => {
    whatsappClient.on('qr', (qr) => {
        console.log('\n=========================================');
        console.log('ESCANEA ESTE CÓDIGO QR PARA INICIAR SESIÓN EN WHATSAPP:');
        qrcode.generate(qr, { small: true });
        console.log('\nSi el cdigo de arriba se ve cortado o con lneas, haz clic en este enlace para verlo perfecto:');
        console.log('https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(qr));
        console.log('=========================================\n');
    });

    whatsappClient.on('ready', () => {
        console.log('¡Cliente de WhatsApp Web conectado y listo!');
    });

    whatsappClient.on('authenticated', () => {
        console.log('Autenticación exitosa.');
    });

    whatsappClient.on('auth_failure', msg => {
        console.error('Fallo en autenticación:', msg);
    });

    whatsappClient.initialize();
};

/**
 * Sends a text message back to the user via WhatsApp
 * @param to The phone number to send the message to (without +)
 * @param body The text content of the message
 */
export const sendWhatsAppMessage = async (to: string, body: string) => {
  try {
    const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
    await whatsappClient.sendMessage(chatId, body);
    console.log(`Mensaje enviado a ${to}`);
  } catch (error: any) {
    console.error('Error enviando mensaje WhatsApp:', error);
    fs.appendFileSync('whatsapp_error.log', new Date().toISOString() + ' - Error sending text message: ' + JSON.stringify(error) + '\n');
  }
};

/**
 * Downloads a media file from an incoming message
 * @param msg The whatsapp-web.js Message object
 * @returns The absolute path to the downloaded temporary file, or null if failed
 */
export const downloadWhatsAppMedia = async (msg: any): Promise<string | null> => {
  try {
    if (!msg.hasMedia) return null;
    const media = await msg.downloadMedia();
    if (!media) return null;
    
    // Determine extension from mimetype
    let extension = 'bin';
    if (media.mimetype.includes('audio/ogg')) extension = 'ogg';
    else if (media.mimetype.includes('audio/mp4')) extension = 'mp4';
    else if (media.mimetype.includes('image/jpeg')) extension = 'jpg';
    else if (media.mimetype.includes('image/png')) extension = 'png';
    else if (media.mimetype.includes('video/mp4')) extension = 'mp4';
    
    const tempFilePath = path.join(os.tmpdir(), `whatsapp_media_${Date.now()}.${extension}`);
    fs.writeFileSync(tempFilePath, media.data, 'base64');
    return tempFilePath;
  } catch (error: any) {
    console.error('Error downloading media:', error);
    return null;
  }
};
