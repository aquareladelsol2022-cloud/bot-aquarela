import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { getAiResponse, transcribeAudio } from './services/ai.service';
import { whatsappClient, initWhatsAppClient, sendWhatsAppMessage, downloadWhatsAppMedia } from './services/whatsapp.service';
import { guardarReservaCSV } from './services/reservas.service';
import { agregarEventoCalendario } from './services/calendar.service';
import { MessageMedia } from 'whatsapp-web.js';

dotenv.config();

// Iniciar un servidor Express en el puerto de Railway para que mantenga el contenedor VIVO
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot de La Aquarela está vivo y corriendo.'));
app.listen(port, () => console.log(`Servidor web escuchando en el puerto ${port}`));

// Inicializar el cliente de WhatsApp Web (generará el código QR en consola)
initWhatsAppClient();

whatsappClient.on('message', async (msg) => {
    // Ignorar mensajes de estados
    if (msg.isStatus) return;

    const from = msg.from; // formato: numero@c.us
    const phoneNumber = from.split('@')[0] || from;

    let msgBody = '';
    
    if (msg.type === 'chat') {
        msgBody = msg.body;
        console.log(`Mensaje de texto de ${phoneNumber}: ${msgBody}`);
    } else if (msg.type === 'audio' || msg.type === 'ptt') {
        console.log(`Recibido audio de ${phoneNumber}. Transcribiendo...`);
        const audioPath = await downloadWhatsAppMedia(msg);
        if (audioPath) {
            const transcribedText = await transcribeAudio(audioPath);
            try { fs.unlinkSync(audioPath); } catch (e) { } 
            
            if (transcribedText) {
                msgBody = `🎤 [Audio]: ${transcribedText}`;
                console.log(`Audio transcrito: ${msgBody}`);
            } else {
                msgBody = 'Lo siento, no pude entender el audio.';
            }
        } else {
            msgBody = 'Lo siento, no pude descargar el audio para escucharlo.';
        }
    } else if (msg.type === 'image') {
        msgBody = '📷 [Imagen recibida]';
    } else {
        console.log(`Tipo de mensaje no soportado: ${msg.type}`);
        return; 
    }

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

            const ownerPhone = process.env.OWNER_PHONE || '573183764628';
            const ownerMsg = `🚨 *¡NUEVA RESERVA AUTOMÁTICA!* 🚨\n\n👤 *Nombre:* ${reserva.nombre}\n📅 *Fecha y Hora:* ${fechaLegible}\n👥 *Personas:* ${reserva.personas}\n📝 *Detalles:* ${reserva.detalles || 'Ninguno'}\n📞 *Teléfono Cliente:* ${phoneNumber}`;
            await sendWhatsAppMessage(ownerPhone, ownerMsg);

            aiResponse = `¡Perfecto ${reserva.nombre}! Tu reserva para ${reserva.personas} personas el ${fechaLegible} ha sido confirmada con éxito. 🥳 ¡Te esperamos en La Aquarela!`;
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

➡️ Puedes reservar con 4 horas de anterioridad si son menos de 10 personas sin decoración y preorden.
➡️ Para grupos de 10 personas o más y con preorden del menú especial debes reservar con 8 días de anterioridad.

CONSIGNACIÓN
Cta ahorro bancolombia 
066-000081-57
Restaurante la Aquarela
Nit: 901220903
Los gastos del envío los asume el cliente (se refiere al valor de la transacción).

IMPORTANTE:
Envía el soporte (foto del recibo o pantallazo) de la consignación por Whatsapp con los siguientes datos:
🙍‍♀️ Nombre completo:
📲 Número de celular:
💻 Correo electrónico:
📆 Día de la reserva:
⏰ Hora de la reserva:
👨‍👩‍👦 Cantidad de personas:
🎂 Tipo de Evento (Dama u Hombre):
📍 Zona:
🎈 Decoración elegida:
💰 Valor:

Nota: informar si hay personas alérgicas a algún producto, si necesitan silla de ruedas. 
❗ Si no puedes asistir en la fecha indicada, tienes un plazo de 2 meses para agendarla nuevamente. La Aquarela no realiza devolución del dinero.
No sé admite el ingreso alimentos y bebidas.`;
        aiResponse = aiResponse.replace('[ENVIAR_DATOS_PAGO]', bankDetails);
    }

    // --- MANEJO DE PROMO 2x1 ---
    const sendsPromo = aiResponse.includes('[ENVIAR_PROMO_2X1]');
    if (sendsPromo) {
        const promoDetails = `Hola 👋 

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

    const sendsDecoraciones = aiResponse.includes('[ENVIAR_FOTO_DECORACIONES]');
    if (sendsDecoraciones) aiResponse = aiResponse.replace('[ENVIAR_FOTO_DECORACIONES]', '').trim();

    let sendsZonaFoto: string | null = null;
    const fotoMatch = aiResponse.match(/\[ENVIAR_FOTOS\]\s*([A-Za-z0-9_.-]+)/);
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
            const media = MessageMedia.fromFilePath(pdfPath);
            await whatsappClient.sendMessage(from, media, { caption: 'Aquí tienes nuestro menú en PDF.', sendMediaAsDocument: true });
        }
    }

    if (sendsDecoraciones) {
        const imgPath = path.join(process.cwd(), 'decoraciones.jpg');
        if (fs.existsSync(imgPath)) {
            const media = MessageMedia.fromFilePath(imgPath);
            await whatsappClient.sendMessage(from, media, { caption: '¡Conoce nuestras espectaculares opciones de decoración! 🎉' });
        }
    }

    if (sendsZonaFoto) {
        const folderPath = path.join(process.cwd(), 'media', sendsZonaFoto);
        if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
            const files = fs.readdirSync(folderPath).filter(f => f.match(/\.(jpg|jpeg|png)$/i)).slice(0, 4);
            if (files.length > 0) {
                for (const file of files) {
                    const imgPath = path.join(folderPath, file);
                    const media = MessageMedia.fromFilePath(imgPath);
                    await whatsappClient.sendMessage(from, media);
                }
                await sendWhatsAppMessage(from, '¡Mira qué hermosas son nuestras instalaciones! 🤩');
            }
        }
    }
});
