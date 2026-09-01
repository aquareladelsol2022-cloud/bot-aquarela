import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Load the knowledge base
const knowledgeBasePath = path.join(process.cwd(), 'knowledge_base.md');
let knowledgeBase = '';
try {
  knowledgeBase = fs.readFileSync(knowledgeBasePath, 'utf8');
} catch (error) {
  console.error('Error loading knowledge base:', error);
}

// System prompt instructing the AI how to behave
const systemPrompt = `
Eres el agente virtual de ventas y reservas del Restaurante y Parque Temático "La Aquarela".
Tu objetivo es brindar una atención al cliente excepcional, cerrar ventas y generar reservas siguiendo las reglas del negocio.

Esta es tu base de conocimientos sobre el Restaurante "La Aquarela":
${knowledgeBase}

Reglas generales de tu personalidad:
1. Sé amable, cálido y profesional. Usa emojis con moderación para mantener una comunicación fresca.
2. Si un cliente pregunta por precios o reglas de reserva, consulta estrictamente la base de conocimientos.
3. Si el cliente pide la ubicación, entrégale la dirección y el link de Google Maps.
4. NUNCA inventes información que no esté en la base de conocimientos. Si no sabes algo, indica que consultarás con un humano.
5. Intenta que tus respuestas sean concisas y fáciles de leer. NUNCA uses símbolos de numeral (#) ni asteriscos (*) en tus respuestas. Escribe texto limpio y acompáñalo con algunos emojis para que se vea estético.
6. SI el cliente pide ver el menú, incluye EXACTAMENTE esta palabra oculta en tu respuesta: [ENVIAR_PDF].
7. IMPORTANTE PARA RESERVAS: Si el cliente desea reservar, debes recopilar de forma amigable TODOS estos datos ANTES de confirmar:
   - Nombre a quien queda la reserva.
   - Fecha y hora (debe tener al menos 4 horas de anticipación).
   - Número de personas.
   - **Preguntas obligatorias**: Debes preguntarle si celebran un motivo especial, si desean algún tipo de decoración, en qué zona desean ubicarse, si hay personas alérgicas y si requieren silla de ruedas.
   - **Abono Obligatorio**: Si la reserva lleva pre-orden de comida, infórmale que requiere el 50% de abono. Si lleva decoración, el 100% de la decoración. Si no lleva decoración ni pre-orden, es gratis.
8. CUANDO YA TENGAS TODOS LOS DATOS PARA LA RESERVA y el cliente haya aceptado la cotización/abono, debes responder con un mensaje amigable confirmando que procedes a agendar, y al final de tu mensaje debes incluir EXACTAMENTE este bloque oculto en formato JSON (NUNCA OLVIDES ESTE BLOQUE):
[RESERVA_TRIGGER] {"nombre": "Juan", "fecha": "2024-10-15 14:00", "personas": 4, "detalles": "Zona cosmos 105, Cumpleaños"}
9. SI el cliente quiere ver FOTOS de alguna de las ZONAS o DECORACIONES del restaurante (ej. piscina, agua, parqueadero, decoracion_romantica), TIENES QUE INCLUIR OBLIGATORIAMENTE Y SIN EXCEPCIÓN esta palabra oculta en tu respuesta: [ENVIAR_FOTOS]nombre_de_la_carpeta (Sustituyendo nombre_de_la_carpeta por la carpeta correspondiente de la base de conocimientos, ej. [ENVIAR_FOTOS]agua o [ENVIAR_FOTOS]decoracion_romantica).
   **REGLA CRÍTICA**: Nunca olvides incluir [ENVIAR_FOTOS]nombre_de_la_carpeta cuando hables de fotos, de lo contrario el sistema fallará. Tu única acción debe ser usar el texto [ENVIAR_FOTOS]. No llames a herramientas de reservas.
10. SI el cliente pregunta por la promoción 2x1, incluye EXACTAMENTE esta palabra oculta en tu respuesta: [ENVIAR_PROMO_2X1]. ¡NO intentes dictar los platos tú mismo!
11. COTIZACIONES Y COMANDAS: Si el cliente te pide una cotización o está planeando un evento, debes calcular los costos según las reglas de la base de conocimientos y mostrarle la cotización en este formato EXACTO en markdown:

📋 *COTIZACIÓN - EVENTOS LA AQUARELA* 📋
👤 *Cliente:* [Nombre]
👥 *No. Personas:* [Número]
📍 *Ubicación:* [Zona]
🗓️ *Fecha del Evento:* [Fecha]

*Detalle de Pedido:*
- [Cantidad]x [Plato/Servicio]: $[Precio Total]
...

💰 *TOTAL NETO:* $[Total] COP
💵 *TOTAL A CANCELAR (ABONO REQUERIDO):* $[Monto del Abono según las reglas] COP

*(Aviso: La propina es voluntaria y se decide en el restaurante. Si hay decoración se abona el 100%, si hay comida el 50%. No hay devoluciones de dinero).*
`;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// In-memory conversation history
const conversations: Record<string, ChatMessage[]> = {};

/**
 * Sends a message to OpenAI and gets the agent's response.
 * @param message The user's message
 * @param phone The user's phone number (used for conversation history memory in the future)
 * @returns The AI's response text
 */
export const getAiResponse = async (message: string, phone: string): Promise<string> => {
  try {
    const currentDateTime = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'full', timeStyle: 'short' });
    const dynamicSystemPrompt = systemPrompt + `\n\n[CONTEXTO DE TIEMPO REQUERIDO PARA PROMOCIONES Y RESERVAS]\nFECHA Y HORA ACTUAL: Hoy es ${currentDateTime}.\nUsa esta fecha como referencia para saber qué día es "hoy", "mañana", o cuando el cliente indique un día de la semana. TEN EN CUENTA EL DÍA DEL EVENTO AL COTIZAR: Si el evento que cotizas cae un fin de semana o festivo, las promociones 2x1 NO APLICAN (se cobra el precio normal por 1 solo plato).`;

    // Initialize history if it doesn't exist
    if (!conversations[phone]) {
      conversations[phone] = [
        { role: 'system', content: dynamicSystemPrompt }
      ];
    } else {
      // Siempre actualizar el system prompt para tener la hora más reciente
      const conv = conversations[phone];
      if (conv && conv[0]) {
        conv[0].content = dynamicSystemPrompt;
      }
    }

    // Add user message to history
    conversations[phone].push({ role: 'user', content: message });

    // Keep only the last 15 messages to avoid exceeding token limits
    if (conversations[phone] && conversations[phone].length > 15) {
       const sysPrompt = conversations[phone][0];
       const lastMessages = conversations[phone].slice(-14);
       if (sysPrompt) {
         conversations[phone] = [sysPrompt, ...lastMessages];
       }
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Changed to mini for extreme cost savings (~99% cheaper)
      messages: conversations[phone] as any,
      temperature: 0.2, // Low temperature for factual consistency con la knowledge base
    });

    const aiMessage = response.choices[0]?.message;
    
    // Add AI response to history
    if (aiMessage && aiMessage.content) {
       if (conversations[phone]) {
         conversations[phone].push({ role: 'assistant', content: aiMessage.content });
       }
    }
    
    // Check if the AI output the JSON block for reservation directly
    if (aiMessage?.content && aiMessage.content.includes('[RESERVA_TRIGGER]')) {
        // Inyectamos en la memoria que la reserva ya fue exitosa
        if (conversations[phone]) {
          conversations[phone].push({
             role: 'system',
             content: 'CRÍTICO: Ya has realizado la reserva para este cliente exitosamente. NO vuelvas a enviar el bloque [RESERVA_TRIGGER].'
          });
        }
    }

    return aiMessage?.content || 'Lo siento, tuve un problema procesando tu mensaje.';
  } catch (error) {
    console.error('OpenAI Error:', error);
    return 'Disculpa, estoy teniendo intermitencias técnicas en este momento. Por favor intenta en unos minutos.';
  }
};

/**
 * Transcribes an audio file to text using OpenAI Whisper API
 * @param audioFilePath Absolute path to the local audio file
 * @returns Transcribed text, or null if failed
 */
export const transcribeAudio = async (audioFilePath: string): Promise<string | null> => {
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFilePath),
      model: 'whisper-1',
      language: 'es' // Hinting Spanish as it's the expected language
    });
    return transcription.text;
  } catch (error) {
    console.error('Error transcribing audio:', error);
    return null;
  }
};
