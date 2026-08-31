import { google } from 'googleapis';
import path from 'path';

// Ruta al archivo de credenciales JSON que el usuario descargó
const KEYFILEPATH = path.join(__dirname, '../../google-credentials.json');
// Los permisos (scopes) requeridos
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

// Inicializar la autenticación
const auth = new google.auth.GoogleAuth({
  keyFile: KEYFILEPATH,
  scopes: SCOPES,
});

const calendar = google.calendar({ version: 'v3', auth });

/**
 * Agrega un evento al calendario de Google
 */
export const agregarEventoCalendario = async (nombre: string, fechaHora: string, personas: number, detalles: string) => {
  try {
    const calendarId = process.env.CALENDAR_ID || 'bot-reservas@bot-aquarela.iam.gserviceaccount.com';
    
    // Asumimos que la IA retorna un ISO 8601 string gracias al prompt actualizado
    let startDate: Date;
    try {
      startDate = new Date(fechaHora);
      if (isNaN(startDate.getTime())) throw new Error("Invalid Date");
    } catch (e) {
      console.log('Fecha inválida devuelta por la IA, usando la fecha de mañana por defecto.');
      startDate = new Date();
      startDate.setHours(startDate.getHours() + 24); 
    }
    
    const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000); // 2 horas de duración

    const event = {
      summary: `Reserva: ${nombre} (${personas} pax)`,
      description: `Nombre: ${nombre}\nPersonas: ${personas}\nFecha Original: ${fechaHora}\nDetalles: ${detalles}`,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: 'America/Bogota',
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: 'America/Bogota',
      },
    };

    const response = await calendar.events.insert({
      calendarId: calendarId,
      requestBody: event,
    });

    console.log(`Evento creado en Google Calendar: ${response.data.htmlLink}`);
    return response.data.htmlLink;
  } catch (error) {
    console.error('Error al crear evento en Google Calendar:', error);
    return null;
  }
};
