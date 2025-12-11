// Colores para la consola
const colors = {
    reset: "\x1b[0m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    magenta: "\x1b[35m",
};

require("dotenv").config();
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);


const MONGODB_URI = process.env.MONGODB_URI || null;
let MensajeModel = null;

if (MONGODB_URI) {
    console.log(colors.cyan, "[DB] Usando MongoDB Atlas para guardar mensajes.", colors.reset);
    const mongoose = require("mongoose");
    mongoose
        .connect(MONGODB_URI)
        .then(() => {
            console.log(colors.green, "[DB] Conectado correctamente a MongoDB.", colors.reset);
        })
        .catch((err) => {
            console.error(colors.red, "[DB] Error conectando a MongoDB:", err.message, colors.reset);
        });

    const mensajeSchema = new mongoose.Schema(
        {
            autor: String,
            cipherText: String,
            iv: String,
            fecha: String,
        },
        { timestamps: true }
    );

    MensajeModel = mongoose.model("Mensaje", mensajeSchema);
} else {
    console.log(colors.yellow, "[DB] Sin MONGODB_URI, usando solo memoria RAM.", colors.reset);
}

// Guardar los ultimos mensajes (cifrados) en memoria
// Cada elemento: { autor, cipherText, iv, fecha }
const mensajes = [];
const MAX_MENSAJES = 100;

// Servir archivos estáticos desde la carpeta "public"
app.use(express.static("public"));

// (Opcional) función para generar un id anónimo corto a partir del socket.id
function generarIdAnonimo(socketId) {
    // Solo para agrupar mensajes / logs. NO se muestra al usuario como “nombre”.
    return "anon-" + socketId.slice(0, 5);
}

io.on("connection", async (socket) => {
    const idAnonimo = generarIdAnonimo(socket.id);

    console.log(
        `${colors.cyan}[+] Nuevo socket conectado:${colors.reset} ${socket.id} (${idAnonimo})`
    );

    // Enviar al cliente su "identidad" anónima para que sepa cuáles mensajes son suyos
    socket.emit("identidad", { autor: idAnonimo });

    // En este modo, TODOS están autorizados al conectarse
    const autorizado = true;

    // Cargar historial desde DB si existe, sino desde memoria
    let historial = [];
    if (MensajeModel) {
        try {
            // Últimos 30, ordenados del más viejo al más nuevo
            const docs = await MensajeModel.find()
                .sort({ createdAt: -1 })
                .limit(MAX_MENSAJES)
                .lean();
            historial = docs.reverse();
        } catch (err) {
            console.error(colors.red, "[DB] Error leyendo historial:", err.message, colors.reset);
            historial = mensajes;
        }
    } else {
        historial = mensajes;
    }

    socket.emit("historial", historial);

    //  Recibir mensajes del cliente (YA CIFRADOS)
    socket.on("mensaje", (data) => {
        if (!autorizado) {
            console.log(
                `${colors.red}[!] Socket no autorizado intentando mandar mensaje:${colors.reset} ${socket.id}`
            );
            return;
        }

        console.log(`${colors.magenta}========== MENSAJE CIFRADO RECIBIDO ==========${colors.reset}`);
        console.log(`${colors.yellow}Autor anónimo:${colors.reset}`, idAnonimo);
        console.log(`${colors.yellow}CipherText:${colors.reset}`, data.cipherText);
        console.log(`${colors.yellow}IV:${colors.reset}`, data.iv);
        console.log(`${colors.yellow}Fecha:${colors.reset}`, data.fecha);
        console.log(`${colors.magenta}==============================================${colors.reset}`);

        const cipherText = data?.cipherText;
        const iv = data?.iv;
        const fecha = data?.fecha || new Date().toLocaleTimeString();

        if (!cipherText || !iv) {
            console.log("Mensaje inválido recibido (falta cipherText o iv).");
            return;
        }

        // El servidor NO sabe el texto original, solo reenvía y guarda cifrado
        const mensaje = {
            autor: idAnonimo, // ID anónimo, NO es un nombre de usuario
            cipherText,
            iv,
            fecha,
        };

        // Guardar el mensaje cifrado en el array en memoria
        mensajes.push(mensaje);
        if (mensajes.length > MAX_MENSAJES) {
            mensajes.shift();
        }

        // Guardar en DB si está configurada
        // Guardar en DB si está configurada
        if (MensajeModel) {
            const doc = new MensajeModel(mensaje);

            doc.save()
                .then(async () => {
                    // Mantener SOLO los últimos MAX_MENSAJES en la BASE DE DATOS
                    const count = await MensajeModel.countDocuments();

                    if (count > MAX_MENSAJES) {
                        const toDelete = count - MAX_MENSAJES;

                        await MensajeModel.find()
                            .sort({ createdAt: 1 }) // más viejos primero
                            .limit(toDelete)
                            .deleteMany();

                        console.log(`[DB] Eliminados ${toDelete} mensajes antiguos de MongoDB.`);
                    }
                })
                .catch((err) => {
                    console.error("[DB] Error guardando mensaje:", err.message);
                });
        }


        // Enviar el mensaje cifrado a TODOS los clientes
        io.emit("mensaje", mensaje);
    });

    socket.on("disconnect", () => {
        console.log(
            `${colors.cyan}[-] Socket desconectado:${colors.reset} ${socket.id} (${idAnonimo})`
        );
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(
        `${colors.green}Servidor corriendo en puerto:${colors.reset} ${PORT}`
    );
});
