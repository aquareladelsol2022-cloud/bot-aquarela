import { google } from 'googleapis';
import path from 'path';

const KEYFILEPATH = path.join(__dirname, '../../google-credentials.json');
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

let auth: any;
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
    scopes: SCOPES,
  });
} else {
  auth = new google.auth.GoogleAuth({
    keyFile: KEYFILEPATH,
    scopes: SCOPES,
  });
}

const sheets = google.sheets({ version: 'v4', auth });

/**
 * Agrega una fila con la reserva a un Google Sheet
 */
export const guardarReservaExcel = async (reserva: any, telefono: string) => {
  try {
    const spreadsheetId = process.env.SPREADSHEET_ID;
    if (!spreadsheetId) {
      console.log('No se encontró SPREADSHEET_ID en las variables de entorno. Omitiendo guardado en Excel.');
      return false;
    }
    
    // Parsear fecha y hora
    const fechaHora = reserva.fecha_hora || reserva.fecha || '';
    let fechaSolo = fechaHora;
    let horaSolo = '';
    if (fechaHora.includes(' ')) {
      const parts = fechaHora.split(' ');
      fechaSolo = parts[0];
      horaSolo = parts.slice(1).join(' ');
    }

    const telefonoReal = reserva.telefono_contacto || telefono;

    // Columnas: FECHA DE RESERVA | HORA | NOMBRE | CELULAR | PERSONAS | ZONA | DECORACION | MESERO | ABONO | QUIEN LA HIZO | OBSERVACION
    const values = [
      [
        fechaSolo,
        horaSolo,
        reserva.nombre || '',
        telefonoReal,
        reserva.personas || '',
        reserva.zona || '',
        reserva.decoracion || 'Ninguna',
        reserva.mesero || 'No',
        reserva.abono || '0',
        'Bot de IA',
        reserva.observacion || reserva.detalles || ''
      ]
    ];

    const resource = {
      values,
    };

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Sheet1!A:K', 
      valueInputOption: 'USER_ENTERED',
      requestBody: resource,
    });

    console.log(`Reserva guardada en Google Sheets exitosamente.`);
    return true;
  } catch (error: any) {
    // Fallback: si falla porque la hoja no se llama Sheet1, intentamos con "Hoja 1"
    if (error.message && error.message.includes('Unable to parse range')) {
        try {
            console.log('Fallo Sheet1, intentando con Hoja 1');
            const fechaHora = reserva.fecha_hora || reserva.fecha || '';
            let fechaSolo = fechaHora;
            let horaSolo = '';
            const parts = fechaHora.split(' ');
            if (parts.length > 1) {
              fechaSolo = parts[0];
              horaSolo = parts.slice(1).join(' ');
            }
            const telefonoFallback = reserva.telefono_contacto || telefono;
            const values = [[fechaSolo, horaSolo, reserva.nombre || '', telefonoFallback, reserva.personas || '', reserva.zona || '', reserva.decoracion || 'Ninguna', reserva.mesero || 'No', reserva.abono || '0', 'Bot de IA', reserva.observacion || reserva.detalles || '']];
            const resource = { values };
            await sheets.spreadsheets.values.append({
                spreadsheetId: process.env.SPREADSHEET_ID as string,
                range: 'Hoja 1!A:K',
                valueInputOption: 'USER_ENTERED',
                requestBody: resource,
            });
            console.log(`Reserva guardada en Google Sheets (Hoja 1) exitosamente.`);
            return true;
        } catch(e) {
            console.error('Error al guardar reserva en Google Sheets con Hoja 1:', e);
            return false;
        }
    }
    console.error('Error al guardar reserva en Google Sheets:', error);
    return false;
  }
};
