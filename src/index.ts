import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { getAiResponse, transcribeAudio } from './services/ai.service';
import { sock, initWhatsAppClient, sendWhatsAppMessage, downloadWhatsAppMedia } from './services/whatsapp.service';
import { guardarReservaCSV } from './services/reservas.service';
import { agregarEventoCalendario } from './services/calendar.service';
import { guardarReservaExcel } from './services/sheets.service';

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
        
        // Ignorar estados de WhatsApp
        if (!msg.message || from === 'status@broadcast') return;
        
        // Si es un grupo, el número real del cliente viene en 'participant'
        const isGroup = from.endsWith('@g.us');
        const senderJid = isGroup ? msg.key.participant : from;
        const phoneNumber = senderJid ? senderJid.split('@')[0].split(':')[0] : from.split('@')[0];

        // Extraer texto del mensaje para asegurarnos de que es un mensaje real
        const textMessage = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';

        // Si el mensaje fue enviado por el humano (y tiene texto real, no es un evento de sincronización del sistema)
        if (fromMe) {
            if (textMessage.trim().length > 0) {
                console.log(`[PAUSA] Humano intervino en el chat con ${phoneNumber}. Bot pausado por 30 mins. (Texto: ${textMessage})`);
                humanTakeover[from] = Date.now();
            }
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
        } else if (messageType === 'imageMessage' || messageType === 'documentMessage' || messageType === 'videoMessage') {
            const now = Date.now();
            if (lastImageReply[phoneNumber] && (now - lastImageReply[phoneNumber] < 60000)) {
                console.log(`Ignorando imagen/documento consecutivo de ${phoneNumber}`);
                return; 
            }
            lastImageReply[phoneNumber] = now;
            msgBody = '[SYSTEM: El cliente acaba de enviarte una o varias FOTOS o DOCUMENTOS. Dile amablemente que como eres una IA no puedes ver archivos, pero que si es un comprobante de pago, un asesor humano lo revisará en breve.]';
            
            // Avisar al dueño para que revise el pago
            const ownerPhone = process.env.OWNER_PHONE || '573126868728';
            const alertMsg = `💸 *¡POSIBLE COMPROBANTE DE PAGO RECIBIDO!* 💸\n\nEl cliente con número ${phoneNumber} acaba de enviar una foto o documento al chat.\nPor favor revisa su conversación para verificar el pago de la reserva.`;
            await sendWhatsAppMessage(ownerPhone, alertMsg);
            
            // Pausar al bot para que el humano pueda confirmar el recibo tranquilamente
            humanTakeover[from] = Date.now();
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
            const afterTrigger = aiResponse.split('[RESERVA_TRIGGER]')[1] || '';
            const jsonMatch = afterTrigger.match(/\{[\s\S]*?\}/);
            try {
                if (!jsonMatch) throw new Error("No JSON found");
                const reserva = JSON.parse(jsonMatch[0]);
                reserva.fecha_hora = reserva.fecha_hora || reserva.fecha;
                const detallesCompletos = reserva.detalles || `Zona: ${reserva.zona || 'N/A'}, Decoración: ${reserva.decoracion || 'N/A'}`;
                guardarReservaCSV(reserva.nombre, reserva.fecha_hora, reserva.personas, detallesCompletos);
                await agregarEventoCalendario(reserva.nombre, reserva.fecha_hora, reserva.personas, detallesCompletos);
                
                await guardarReservaExcel(reserva, phoneNumber);
                
                let fechaLegible = reserva.fecha_hora;
                try {
                    const dateObj = new Date(reserva.fecha_hora);
                    fechaLegible = dateObj.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'full', timeStyle: 'short' });
                } catch(e) {}

                const ownerPhone = process.env.OWNER_PHONE || '573126868728';
                const telefonoReal = reserva.telefono_contacto || phoneNumber;
                const ownerMsg = `🎊 *¡PRE-RESERVA REGISTRADA!* 🎊\n\n👤 *Nombre:* ${reserva.nombre}\n📅 *Fecha y Hora:* ${fechaLegible}\n👥 *Personas:* ${reserva.personas}\n📝 *Detalles:* ${reserva.detalles || 'Ninguno'}\n📱 *Teléfono Cliente:* ${telefonoReal}\n\n⚠️ *ESTADO:* Pendiente de pago/confirmación. El cliente está terminando el proceso en WhatsApp. Si requería abono, se le acaban de enviar los datos bancarios.`;
                await sendWhatsAppMessage(ownerPhone, ownerMsg);

                aiResponse = `¡Perfecto ${reserva.nombre}! Tu reserva para ${reserva.personas} personas el ${fechaLegible} ha sido confirmada con éxito. 🥳 ¡Te esperamos en La Aquarela!`;
            } catch (e: any) {
                console.error("Error parsing reservation tool arguments", e);
                aiResponse = "Tuvimos un pequeño inconveniente procesando tu reserva. Un asesor humano se contactará contigo en unos minutos.";
            }
        }

        // --- MANEJO DE ESCALAMIENTO A HUMANO ---
        if (aiResponse.includes('[ESCALAR_HUMANO]')) {
            aiResponse = aiResponse.replace('[ESCALAR_HUMANO]', '').trim();
            const ownerPhone = process.env.OWNER_PHONE || '573126868728';
            const alertMsg = `🚨 *¡ALERTA DE ATENCIÓN!* 🚨\n\nEl bot se ha enredado o el cliente está molesto/necesita ayuda humana urgente.\n\n📱 *Teléfono Cliente:* ${phoneNumber}\nRevisa la conversación de inmediato.`;
            await sendWhatsAppMessage(ownerPhone, alertMsg);
            
            // Pausar el bot para este cliente por 30 minutos para que el humano intervenga
            humanTakeover[from] = Date.now();
        }

        // --- MANEJO DE DATOS DE PAGO ---
        const sendsDatosPago = aiResponse.includes('[ENVIAR_DATOS_PAGO]');
        if (sendsDatosPago) {
            const bankDetails = `
💳 *DATOS PARA CONSIGNACIÓN*
Cta ahorro Bancolombia 
066-000081-57
Restaurante La Aquarela
Nit: 901220903
*(Los gastos de la transacción los asume el cliente).*

⚠️ *IMPORTANTE PARA CONFIRMAR TU RESERVA:*
Por favor, envíanos por este medio la **foto o el pantallazo del comprobante de pago**. 
Como ya tomamos tus datos, solo necesitamos el comprobante para dejar tu reserva confirmada al 100%.

📌 *Nota:* Si no puedes asistir en la fecha indicada, tienes un plazo de 2 meses para agendarla nuevamente. La Aquarela NO realiza devolución del dinero.`;
            aiResponse = aiResponse.replace('[ENVIAR_DATOS_PAGO]', bankDetails);
        }

        // --- MANEJO DE PROMO 2x1 ---
        const sendsPromo = aiResponse.includes('[ENVIAR_PROMO_2X1]');
        if (sendsPromo) {
            const promoDetails = `Hola 🌟 Te cuento que tenemos las siguientes ofertas súper especiales:\n\n🍳 *DESAYUNOS 2X1* (Todos los días de 7 AM a 11 AM)\n- Omelette, pericos o huevos ($20,000)\n- Calentados ($26,000)\n- Tamales ($38,000)\n\n🍝 *ALMUERZOS Y CENAS 2X1* (Lunes a Viernes TODO EL DÍA, excepto festivos)\n- Pastas (Ej. Frutos del Mar $75,000)\n- Carnes y Pescados (Ej. Suprema de pollo $65,000)\n- Hamburguesa Angus ($55,000)\n\n¿Te gustaría reservar para aprovechar alguna de estas promociones? 😊`;
            aiResponse = aiResponse.replace('[ENVIAR_PROMO_2X1]', promoDetails);
        }

        const sendsPdf = aiResponse.includes('[ENVIAR_PDF]');
        if (sendsPdf) aiResponse = aiResponse.replace('[ENVIAR_PDF]', '').trim();

        console.log(`[DEBUG] Respuesta cruda de OpenAI: ${aiResponse}`);

        let sendsZonasFotos: string[] = [];
        const regexFotos = /\[ENVIAR_FOTOS\]\s*([A-Za-z0-9_-]+)/g;
        let match;
        while ((match = regexFotos.exec(aiResponse)) !== null) {
            if (match[1]) {
                sendsZonasFotos.push(match[1].trim());
            }
        }
        aiResponse = aiResponse.replace(/\[ENVIAR_FOTOS\]\s*([A-Za-z0-9_-]+)/g, '').trim();

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

        if (sendsZonasFotos.length > 0) {
            for (const zonaFoto of sendsZonasFotos) {
                const mediaPath = path.join(process.cwd(), 'media');
                if (!fs.existsSync(mediaPath)) continue;
                
                const folders = fs.readdirSync(mediaPath);
                const realFolder = folders.find(f => f.toLowerCase() === zonaFoto.toLowerCase());
                
                if (!realFolder) {
                    console.log(`[DEBUG FOTOS] No se encontró la carpeta para ${zonaFoto}`);
                    continue;
                }
                
                const folderPath = path.join(mediaPath, realFolder);
                console.log(`[DEBUG FOTOS] Enviando fotos de: ${realFolder}`);
                
                if (fs.statSync(folderPath).isDirectory()) {
                    const files = fs.readdirSync(folderPath).filter(f => f.match(/\.(jpg|jpeg|png)$/i)).slice(0, 10);
                    if (files.length > 0) {
                        for (const file of files) {
                            const imgPath = path.join(folderPath, file);
                            await sock.sendMessage(from, { image: fs.readFileSync(imgPath) });
                        }
                        await sendWhatsAppMessage(from, `Estas son las fotos de ${realFolder.replace(/_/g, ' ')} 😊`);
                    }
                }
            }
        }
    } catch (e) {
        console.error("Error global en el handler de mensajes:", e);
    }
};

// Inicializar el cliente de WhatsApp Web (generará el código QR en consola)
initWhatsAppClient(handleMessage);
