import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { getAiResponse, transcribeAudio } from './services/ai.service';
import { sock, initWhatsAppClient, sendWhatsAppMessage, downloadWhatsAppMedia } from './services/whatsapp.service';
import { guardarReservaCSV } from './services/reservas.service';
import { agregarEventoCalendario } from './services/calendar.service';

dotenv.config();

// Iniciar un servidor Express en el puerto de Railway para que mantenga el contenedor VIVO
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot de La Aquarela está vivo y corriendo con Baileys.'));
app.listen(port, () => console.log(`Servidor web escuchando en el puerto ${port}`));

// Memoria temporal para pausar el bot si un humano interviene
const humanTakeover: Record<string, number> = {};
const TAKEOVER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos de pausa
const lastImageReply: Record<string, number> = {};

const handleMessage = async (msg: any) => {
    try {
        const fromMe = msg.key.fromMe;
        const from = msg.key.remoteJid;
        const phoneNumber = from.split('@')[0];

        // Si el mensaje fue enviado por el humano desde el celular de la empresa
        if (fromMe) {
            console.log(`[PAUSA] Humano intervino en el chat con ${phoneNumber}. Bot pausado por 30 mins.`);
            humanTakeover[from] = Date.now();
            return;
        }

        // Si el chat está en modo "humano", ignorar los mensajes del cliente
        if (humanTakeover[from]) {
            const timeSinceTakeover = Date.now() - humanTakeover[from];
            if (timeSinceTakeover < TAKEOVER_TIMEOUT_MS) {
                console.log(`[SILENCIO] Chat con ${phoneNumber} está siendo manejado por un humano.`);
                return;
            } else {
                // Ya pasó el tiempo de pausa, reactivar el bot
                delete humanTakeover[from];
                console.log(`[ACTIVO] Bot reactivado para el chat con ${phoneNumber}.`);
            }
        }

        // Desenvolver mensajes efímeros o de ver una vez
        let actualMessage = msg.message;
        if (actualMessage?.ephemeralMessage) {
            actualMessage = actualMessage.ephemeralMessage.message;
        } else if (actualMessage?.viewOnceMessageV2) {
            actualMessage = actualMessage.viewOnceMessageV2.message;
        }

        let msgBody = '';
        let messageType = Object.keys(actualMessage || {})[0];
        
        // Manejar mensajes que vienen de botones o citas
        if (messageType === 'extendedTextMessage') {
            msgBody = actualMessage.extendedTextMessage?.text;
        } else if (messageType === 'conversation') {
            msgBody = actualMessage.conversation;
        } else if (messageType === 'audioMessage') {
            console.log(`Recibido audio de ${phoneNumber}. Transcribiendo...`);
            const audioPath = await downloadWhatsAppMedia(msg);
            if (audioPath) {
                const transcribedText = await transcribeAudio(audioPath);
                try { fs.unlinkSync(audioPath); } catch (e) { } 
                
                if (transcribedText) {
                    msgBody = `🎙️ [Audio]: ${transcribedText}`;
                    console.log(`Audio transcrito: ${msgBody}`);
                } else {
                    msgBody = 'Lo siento, no pude entender el audio.';
                }
            } else {
                msgBody = 'Lo siento, no pude descargar el audio para escucharlo.';
            }
        } else if (messageType === 'imageMessage') {
            const now = Date.now();
            if (lastImageReply[phoneNumber] && (now - lastImageReply[phoneNumber] < 60000)) {
                console.log(`Ignorando imagen consecutiva de ${phoneNumber}`);
                return; 
            }
            lastImageReply[phoneNumber] = now;
            msgBody = '[SYSTEM: El cliente acaba de enviarte una o varias FOTOS. Dile amablemente que como eres una IA no puedes ver fotos, pero que si es un comprobante de pago de reserva, un asesor humano lo revisará en breve.]';
        } else {
            console.log(`Tipo de mensaje ignorado: ${messageType}`);
            return;
        }

        if (!msgBody) return;

        // Obtener respuesta de la IA
        console.log('Thinking...');
        let aiResponse = await getAiResponse(msgBody, phoneNumber);
        
        // --- MANEJO DE RESERVAS ---
        if (aiResponse.includes('[RESERVA_TRIGGER]')) {
            const jsonArgs = aiResponse.replace('[RESERVA_TRIGGER]', '').trim();
            const cleanJsonArgs = jsonArgs.replace(/```json/gi, '').replace(/```/g, '').trim();
            
            try {
                const reserva = JSON.parse(cleanJsonArgs);
                guardarReservaCSV(reserva.nombre, reserva.fecha_hora, reserva.personas, reserva.detalles);
                await agregarEventoCalendario(reserva.nombre, reserva.fecha_hora, reserva.personas, reserva.detalles);
                
                let fechaLegible = reserva.fecha_hora;
                try {
                    const dateObj = new Date(reserva.fecha_hora);
                    fechaLegible = dateObj.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'full', timeStyle: 'short' });
                } catch(e) {}

                const ownerPhone = process.env.OWNER_PHONE || '573126868728';
                const ownerMsg = `🗓️ *¡NUEVA RESERVA AUTOMÁTICA!* 🗓️\n\n👤 *Nombre:* ${reserva.nombre}\n🕒 *Fecha y Hora:* ${fechaLegible}\n👥 *Personas:* ${reserva.personas}\n📝 *Detalles:* ${reserva.detalles || 'Ninguno'}\n📱 *Teléfono Cliente:* ${phoneNumber}`;
                await sendWhatsAppMessage(ownerPhone, ownerMsg);

                aiResponse = `¡Perfecto ${reserva.nombre}! Tu reserva para ${reserva.personas} personas el ${fechaLegible} ha sido confirmada con éxito. 🎉 ¡Te esperamos en La Aquarela!`;
            } catch (e: any) {
                console.error("Error parsing reservation tool arguments", e);
                aiResponse = "Tuvimos un pequeño inconveniente procesando tu reserva. Un asesor humano se contactará contigo en unos minutos.";
            }
        }

        // --- MANEJO DE DATOS DE PAGO ---
        const sendsDatosPago = aiResponse.includes('[ENVIAR_DATOS_PAGO]');
        if (sendsDatosPago) {
            const bankDetails = `
¿CÓMO RESERVAR?
Indícanos si tienes un motivo especial para celebrar, escoge la decoración, realiza la pre-orden (si deseas) y elige la zona. La reserva se realiza con el pago anticipado del 50% de la cuenta.

📌 Puedes reservar con 4 horas de anterioridad si son menos de 10 personas sin decoración y preorden.
📌 Para grupos de 10 personas o más y con preorden del menú especial debes reservar con 8 días de anterioridad.

CONSIGNACIÓN
Cta ahorro bancolombia 
066-000081-57
Restaurante la Aquarela
Nit: 901220903
Los gastos del envío los asume el cliente (se refiere al valor de la transacción).

IMPORTANTE:
Envía el soporte (foto del recibo o pantallazo) de la consignación por Whatsapp con los siguientes datos:
🧑🏻‍🦱👩🏽 Nombre completo:
📱 Número de celular:
📧 Correo electrónico:
📅 Día de la reserva:
⏰ Hora de la reserva:
🕺🏻💃🏽🕺🏻 Cantidad de personas:
🪩 Tipo de Evento (Dama u Hombre):
🌅 Zona:
🎈 Decoración elegida:
💰 Valor:

Nota: informar si hay personas alérgicas a algún producto, si necesitan silla de ruedas. 
🛑 Si no puedes asistir en la fecha indicada, tienes un plazo de 2 meses para agendarla nuevamente. La Aquarela no realiza devolución del dinero.
No sé admite el ingreso alimentos y bebidas.`;
            aiResponse = aiResponse.replace('[ENVIAR_DATOS_PAGO]', bankDetails);
        }

        // --- MANEJO DE PROMO 2x1 ---
        const sendsPromo = aiResponse.includes('[ENVIAR_PROMO_2X1]');
        if (sendsPromo) {
            const promoDetails = `Hola ☀️ 

Promoción válida: Aplica de lunes a viernes, no festivos, todo el día

Platos 2x1
- Pasta en salsa champiñón: $68,000
- Pasta a la boloñesa: $68,000  
- Pasta en frutos del mar: $75,000
- Pasta de camarones en chontaduro: $80,000

Otros platos
- Cazuela de camarones tres quesos: $74,000
- Trucha al ajillo: $65,000
- Porcha de cerdo: $62,000
- Suprema de pollo a la parrilla: $65,000
- Lomo de cerdo a la pimienta: $65,000
- Frijolada aguapanela: $50,000
- Hamburguesa Angus: $55,000

Bebidas y acompañamientos
- Aguapanela con arepa: $20,000
- Aguapanela con queso doble crema: $20,000
- Chocolate en leche con queso: $24,000
- Michelada de cerveza acuarela: $20,000`;
            aiResponse = aiResponse.replace('[ENVIAR_PROMO_2X1]', promoDetails);
        }

        const sendsPdf = aiResponse.includes('[ENVIAR_PDF]');
        if (sendsPdf) aiResponse = aiResponse.replace('[ENVIAR_PDF]', '').trim();

        console.log(`[DEBUG] Respuesta cruda de OpenAI: ${aiResponse}`);

        let sendsZonaFoto: string | null = null;
        const fotoMatch = aiResponse.match(/\[ENVIAR_FOTOS\]\s*([A-Za-z0-9_-]+)/);
        if (fotoMatch && fotoMatch[1]) {
            sendsZonaFoto = fotoMatch[1].trim();
            aiResponse = aiResponse.replace(fotoMatch[0], '').trim();
        }

        // 1. Enviar el texto principal
        if (aiResponse.length > 0) {
            await sendWhatsAppMessage(from, aiResponse);
        }

        // 2. Enviar archivos adjuntos si los hay
        if (sendsPdf) {
            const pdfPath = path.join(process.cwd(), 'menu.pdf');
            if (fs.existsSync(pdfPath)) {
                await sock.sendMessage(from, { 
                    document: fs.readFileSync(pdfPath), 
                    mimetype: 'application/pdf', 
                    fileName: 'menu.pdf',
                    caption: 'Aquí tienes nuestro menú en PDF.'
                });
            }
        }

        if (sendsZonaFoto) {
            const folderPath = path.join(process.cwd(), 'media', sendsZonaFoto);
            console.log(`[DEBUG FOTOS] El cliente pidió fotos de: ${sendsZonaFoto}`);
            console.log(`[DEBUG FOTOS] Buscando carpeta en la ruta: ${folderPath}`);
            
            const existe = fs.existsSync(folderPath);
            console.log(`[DEBUG FOTOS] ¿La carpeta existe en el servidor (Railway)?: ${existe}`);
            
            if (existe && fs.statSync(folderPath).isDirectory()) {
                const files = fs.readdirSync(folderPath).filter(f => f.match(/\.(jpg|jpeg|png)$/i)).slice(0, 10);
                if (files.length > 0) {
                    for (const file of files) {
                        const imgPath = path.join(folderPath, file);
                        await sock.sendMessage(from, { image: fs.readFileSync(imgPath) });
                    }
                    await sendWhatsAppMessage(from, '¡Aquí tienes las fotos! 📸');
                }
            }
        }
    } catch (e) {
        console.error("Error global en el handler de mensajes:", e);
    }
};

// Inicializar el cliente de WhatsApp Web (generará el código QR en consola)
initWhatsAppClient(handleMessage);
