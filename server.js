// Colores para la consola
const colors = {
    reset: "\x1b[0m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    magenta: "\x1b[35m",
};
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

// Clave de acceso al chat (solo para controlar quién entra)
// NO es la clave de cifrado. Esta sí la conoce el servidor.
const CHAT_ACCESS_CODE = process.env.CHAT_ACCESS_CODE || "Linuxeros";

// 🧠 Aquí guardamos los últimos mensajes (cifrados)
// Cada elemento: { autor, cipherText, iv, fecha }
const mensajes = [];

// Servir archivos estáticos desde la carpeta "public"
app.use(express.static("public"));

io.on("connection", (socket) => {
    console.log(
        `${colors.cyan}[+] Nuevo socket conectado:${colors.reset} ${socket.id}`
    );

    let autorizado = false;
    let nombreUsuario = null;

    // Unirse al chat: nombre + código de acceso
    socket.on("join", ({ nombre, codigoAcceso }) => {
        if (!nombre || !codigoAcceso) {
            socket.emit("joinError", "Debes indicar nombre y código de acceso.");
            return;
        }

        if (codigoAcceso !== CHAT_ACCESS_CODE) {
            socket.emit("joinError", "Código de acceso incorrecto. Acceso denegado.");
            console.log(
                `${colors.red}[X] Código de acceso incorrecto desde socket:${colors.reset} ${socket.id}`
            );

            socket.disconnect();
            return;
        }

        autorizado = true;
        nombreUsuario = nombre;
        console.log(
            `${colors.green}[OK] Usuario autorizado:${colors.reset} ${nombreUsuario} (${socket.id})`
        );


        socket.emit("joinOk", {
            mensaje: "Acceso concedido. Bienvenido al chat.",
            nombre: nombreUsuario,
        });

        // Enviar historial actual (máximo 7 mensajes, cifrados)
        socket.emit("historial", mensajes);
    });

    //  Recibir mensajes del cliente (YA CIFRADOS)
    socket.on("mensaje", (data) => {
        if (!autorizado) {
            console.log(
                `${colors.red}[!] Socket no autorizado intentando mandar mensaje:${colors.reset} ${socket.id}`
            );
            return;
        }

        console.log(`${colors.magenta}========== MENSAJE CIFRADO RECIBIDO ==========${colors.reset}`);
        console.log(`${colors.yellow}Autor:${colors.reset}`, nombreUsuario);
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
            autor: nombreUsuario,
            cipherText,
            iv,
            fecha,
        };

        // Guardar el mensaje cifrado en el array
        mensajes.push(mensaje);

        // 🧹 Mantener solo los últimos 7
        if (mensajes.length > 7) {
            mensajes.shift();
        }

        // Enviar el mensaje cifrado a TODOS los clientes
        io.emit("mensaje", mensaje);
    });

    socket.on("disconnect", () => {
        console.log(
            `${colors.cyan}[-] Socket desconectado:${colors.reset} ${socket.id} - ${nombreUsuario || "sin nombre"
            }`
        );
    });

});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(
        `${colors.green}Servidor corriendo en puerto:${colors.reset} ${PORT}`
    );
});

