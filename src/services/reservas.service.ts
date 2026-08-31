import fs from 'fs';
import path from 'path';

/**
 * Guarda la reserva localmente en un archivo CSV.
 */
export const guardarReservaCSV = (nombre: string, fechaHora: string, personas: number, detalles: string) => {
    const csvPath = path.join(__dirname, '../../reservas.csv');
    const header = 'Fecha de Registro,Nombre,Fecha y Hora,Personas,Detalles\n';
    
    if (!fs.existsSync(csvPath)) {
        fs.writeFileSync(csvPath, header, 'utf8');
    }
    
    const timestamp = new Date().toLocaleString('es-CO');
    // Escape comillas y comas
    const safeNombre = `"${(nombre || 'Desconocido').toString().replace(/"/g, '""')}"`;
    const safeFechaHora = `"${(fechaHora || '').toString().replace(/"/g, '""')}"`;
    const safeDetalles = `"${(detalles || '').toString().replace(/"/g, '""')}"`;
    
    const row = `"${timestamp}",${safeNombre},${safeFechaHora},${personas || 0},${safeDetalles}\n`;
    
    try {
        fs.appendFileSync(csvPath, row, 'utf8');
        console.log('Reserva guardada en reservas.csv');
    } catch (error) {
        console.error('Error no fatal: No se pudo guardar en reservas.csv (Posiblemente el archivo está abierto en otro programa).', error);
    }
};
