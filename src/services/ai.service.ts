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
7. SI el cliente quiere ver fotos de las decoraciones, incluye EXACTAMENTE esta palabra oculta en tu respuesta: [ENVIAR_FOTO_DECORACIONES].
8. CUANDO el cliente ya te haya dado todos los datos de la reserva y acepte realizar el pago, DEBES mandarle los datos bancarios usando EXACTAMENTE esta palabra oculta en tu respuesta: [ENVIAR_DATOS_PAGO]. ¡NO INTENTES DICTAR LA CUENTA BANCARIA TÚ MISMO, USA LA PALABRA MÁGICA!
9. SI el cliente quiere ver FOTOS de alguna de las ZONAS del restaurante, incluye EXACTAMENTE esta palabra oculta en tu respuesta: [ENVIAR_FOTOS]nombre_de_la_carpeta (Sustituyendo nombre_de_la_carpeta por la carpeta correspondiente de la base de conocimientos, ej. agua).
10. SI el cliente pregunta por la promoción 2x1, incluye EXACTAMENTE esta palabra oculta en tu respuesta: [ENVIAR_PROMO_2X1]. ¡NO intentes dictar los platos tú mismo!
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
    // Initialize history if it doesn't exist
    if (!conversations[phone]) {
      conversations[phone] = [
        { role: 'system', content: systemPrompt }
      ];
    }

    // Add user message to history
    conversations[phone].push({ role: 'user', content: message });

    // Keep only the last 15 messages to avoid exceeding token limits
    if (conversations[phone].length > 15) {
       const sysPrompt = conversations[phone][0];
       const lastMessages = conversations[phone].slice(-14);
       if (sysPrompt) {
         conversations[phone] = [sysPrompt, ...lastMessages];
       } else {
         conversations[phone] = lastMessages;
       }
    }

    const dateContext = `Recuerda: La fecha y hora actual en Colombia es ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}. Usa el año actual para las reservas.`;
    const messagesWithContext = [...conversations[phone], { role: 'system', content: dateContext }];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Changed to mini for extreme cost savings (~99% cheaper)
      messages: messagesWithContext as any,
      temperature: 0.2, // Low temperature for factual consistency con la knowledge base
      tools: [
        {
          type: 'function',
          function: {
            name: 'guardar_reserva',
            description: 'Llama a esta función EXCLUSIVAMENTE cuando el cliente haya confirmado que desea reservar y ya te haya proporcionado Nombre, Fecha, Hora y Número de Personas.',
            parameters: {
              type: 'object',
              properties: {
                nombre: { type: 'string', description: 'Nombre completo del cliente' },
                fecha_hora: { type: 'string', description: 'La fecha y hora en formato estricto ISO 8601 para la zona horaria de Colombia (ej. 2026-10-25T15:00:00-05:00)' },
                personas: { type: 'number', description: 'Número total de personas que asistirán' },
                detalles: { type: 'string', description: 'Detalles adicionales, decoración, o alergias. (Vacio si no hay)' }
              },
              required: ['nombre', 'fecha_hora', 'personas']
            }
          }
        }
      ],
      tool_choice: 'auto'
    });

    const aiMessage = response.choices[0]?.message;
    
    // Add AI response to history
    if (aiMessage && aiMessage.content) {
       if (conversations[phone]) {
         conversations[phone].push({ role: 'assistant', content: aiMessage.content });
       }
    }
    
    // Si la IA decide llamar a la herramienta de reserva
    if (aiMessage?.tool_calls && aiMessage.tool_calls.length > 0) {
      const toolCall: any = aiMessage.tool_calls[0];
      if (toolCall?.function?.name === 'guardar_reserva') {
        const args = toolCall.function.arguments;
        
        // Inyectamos en la memoria que la reserva ya fue exitosa, para que no vuelva a llamar a la función en el próximo mensaje
        if (conversations[phone]) {
          conversations[phone].push({ 
             role: 'assistant', 
             content: '¡Perfecto! Tu reserva ha sido confirmada con éxito. Te esperamos.' 
          });
          conversations[phone].push({
             role: 'system',
             content: 'CRÍTICO: Ya has realizado la reserva para este cliente exitosamente. NO vuelvas a llamar a la herramienta guardar_reserva bajo ninguna circunstancia, a menos que el cliente pida explícitamente cambiar o actualizar los datos.'
          });
        }

        // Retornamos un trigger especial para que index.ts lo procese
        return `[RESERVA_TRIGGER]${args}`;
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
