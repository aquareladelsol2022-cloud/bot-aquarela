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

    // Check if row already exists
    let rowIndex = -1;
    let targetSheet = 'Sheet1';
    
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Sheet1!A:K'
      });
      const rows = response.data.values || [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row && row[3] === telefonoReal) {
          rowIndex = i + 1;
          break;
        }
      }
    } catch (e: any) {
      if (e.message && e.message.includes('Unable to parse range')) {
        targetSheet = 'Hoja 1';
        try {
          const res2 = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Hoja 1!A:K'
          });
          const rows2 = res2.data.values || [];
          for (let i = rows2.length - 1; i >= 0; i--) {
            const row2 = rows2[i];
            if (row2 && row2[3] === telefonoReal) {
              rowIndex = i + 1;
              break;
            }
          }
        } catch(e2) {
          console.error('Error reading Hoja 1', e2);
        }
      }
    }

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

    const resource = { values };

    if (rowIndex !== -1) {
      // Update existing row
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${targetSheet}!A${rowIndex}:K${rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: resource,
      });
      console.log(`Reserva actualizada en Google Sheets exitosamente en la fila ${rowIndex}.`);
    } else {
      // Append new row
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${targetSheet}!A:K`,
        valueInputOption: 'USER_ENTERED',
        requestBody: resource,
      });
      console.log(`Reserva añadida en Google Sheets exitosamente.`);
    }

    return true;
  } catch (error: any) {
    console.error('Error al guardar reserva en Google Sheets:', error);
    return false;
  }
};

export const obtenerReservasManana = async () => {
  try {
    const spreadsheetId = process.env.SPREADSHEET_ID;
    if (!spreadsheetId) return [];

    let targetSheet = 'Sheet1';
    let rows: any[] = [];
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Sheet1!A:K' });
      rows = res.data.values || [];
    } catch (e: any) {
      if (e.message && e.message.includes('Unable to parse range')) {
        targetSheet = 'Hoja 1';
        const res2 = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Hoja 1!A:K' });
        rows = res2.data.values || [];
      } else {
        throw e;
      }
    }

    // Calcular la fecha de mañana en formato YYYY-MM-DD (hora Colombia)
    const manana = new Date();
    manana.setHours(manana.getHours() - 5); // Ajuste a Colombia
    manana.setDate(manana.getDate() + 1);
    const fechaMananaStr = manana.toISOString().split('T')[0];

    const reservasManana: any[] = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 4) continue; // Si está vacía o no tiene teléfono
      const fechaReserva = row[0]; // Columna A
      if (fechaReserva && fechaReserva.includes(fechaMananaStr)) {
        reservasManana.push({
          hora: row[1] || '',
          nombre: row[2] || '',
          telefono: row[3] || '',
          personas: row[4] || ''
        });
      }
    }
    return reservasManana;
  } catch (error) {
    console.error('Error al obtener reservas de mañana:', error);
    return [];
  }
};
