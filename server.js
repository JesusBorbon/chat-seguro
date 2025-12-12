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
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const sharp = require("sharp");

// Clave unica permitida para acceder al chat
const CLAVE_UNICA = "Linux";
const EMOJIS_PERMITIDOS = ["❤️", "👍", "😂", "😮", "🙏", "🔥"];

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
            tipo: { type: String, default: "texto" },
            autor: String,
            cipherText: String,
            iv: String,
            fecha: String,
            urlFull: String,
            urlThumb: String,
            mime: String,
            size: Number,
            nombreOriginal: String,
            messageId: { type: String, index: true },
            reacciones: { type: Object, default: {} },
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
const MAX_MENSAJES = 120;
const uploadDir = path.join(__dirname, "public", "uploads");
const MAX_UPLOAD_MB = 10;

fs.mkdirSync(uploadDir, { recursive: true });

function buscarMensajePorId(messageId) {
    if (!messageId) return null;
    return mensajes.find((m) => m.id === messageId || m.messageId === messageId);
}

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const safeExt = ext === ".png" || ext === ".jpg" || ext === ".jpeg" ? ext : ".jpg";
        const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, `img-${unique}${safeExt}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = ["image/png", "image/jpeg", "image/jpg"];
        if (allowed.includes(file.mimetype)) return cb(null, true);
        cb(new Error("Tipo de archivo no permitido"));
    },
});

function generarMensajeId() {
    return "msg-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
}

function normalizarMensaje(raw) {
    const tipo = raw.tipo || (raw.cipherText ? "texto" : "imagen");
    const messageId =
        raw.messageId ||
        raw.id ||
        (raw._id ? String(raw._id) : null) ||
        generarMensajeId();
    const reacciones =
        raw.reacciones && typeof raw.reacciones === "object"
            ? JSON.parse(JSON.stringify(raw.reacciones))
            : {};
    return {
        id: messageId,
        messageId,
        tipo,
        autor: raw.autor,
        cipherText: raw.cipherText,
        iv: raw.iv,
        fecha: raw.fecha || new Date().toLocaleTimeString(),
        urlFull: raw.urlFull,
        urlThumb: raw.urlThumb,
        mime: raw.mime,
        size: raw.size,
        nombreOriginal: raw.nombreOriginal,
        reacciones,
    };
}

async function guardarMensajeEnDB(mensaje) {
    if (!MensajeModel) return;

    try {
        const doc = new MensajeModel(mensaje);
        await doc.save();

        const count = await MensajeModel.countDocuments();
        if (count > MAX_MENSAJES) {
            const toDelete = count - MAX_MENSAJES;
            await MensajeModel.find()
                .sort({ createdAt: 1 })
                .limit(toDelete)
                .deleteMany();

            console.log(`[DB] Eliminados ${toDelete} mensajes antiguos de MongoDB.`);
        }
    } catch (err) {
        console.error("[DB] Error guardando mensaje:", err.message);
    }
}

async function obtenerHistorial() {
    if (MensajeModel) {
        try {
            const docs = await MensajeModel.find()
                .sort({ createdAt: -1 })
                .limit(MAX_MENSAJES)
                .lean();
            const normalizados = docs.reverse().map(normalizarMensaje);
            mensajes.length = 0;
            mensajes.push(...normalizados);
            return normalizados;
        } catch (err) {
            console.error(colors.red, "[DB] Error leyendo historial:", err.message, colors.reset);
            return mensajes.map(normalizarMensaje);
        }
    }

    return mensajes.map(normalizarMensaje);
}

// Servir archivos estaticos desde la carpeta "public"
app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function clearCookieVariants(res, name, req) {
    // Intentamos limpiar con varias combinaciones comunes
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";

    const base = {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure,
    };

    // Sin domain
    res.clearCookie(name, base);

    // Con domain exacto
    const host = (req.headers.host || "").split(":")[0];
    if (host) {
        res.clearCookie(name, { ...base, domain: host });
        // Con .domain para subdominios
        if (host.includes(".")) {
            res.clearCookie(name, { ...base, domain: "." + host });
        }
    }

    // Tambien en path vacio / (a veces apps lo setean distinto)
    res.clearCookie(name, { ...base, path: "/" });
}

app.post("/logout", (req, res) => {
    // Limpia cookies tipicas (por si tu pagina principal o proxy las usa)
    const cookieNamesToClear = [
        process.env.COOKIE_NAME, // si defines COOKIE_NAME en .env
        "token",
        "auth",
        "session",
        "sid",
        "connect.sid", // express-session default
    ].filter(Boolean);

    for (const name of cookieNamesToClear) {
        clearCookieVariants(res, name, req);
    }

    // Si un dia manejas sesiones/token, aqui seria el lugar para invalidarlas (logout global real)
    return res.status(204).end();
});

async function crearMiniaturaPixelada(inputPath, outputPath) {
    // Crea una miniatura "pixelada": baja la resolucion y la reescala con kernel nearest
    await sharp(inputPath)
        .resize({ width: 160, withoutEnlargement: true })
        .resize({ width: 320, kernel: sharp.kernel.nearest })
        .jpeg({ quality: 45 })
        .toFile(outputPath);
}

app.post("/upload", upload.single("imagen"), async (req, res) => {
    if (req.headers["x-chat-key"] !== CLAVE_UNICA) {
        return res.status(401).json({ error: "No autorizado" });
    }

    const archivo = req.file;
    if (!archivo) {
        return res.status(400).json({ error: "No se recibio archivo" });
    }

    try {
        const baseName = path.parse(archivo.filename).name;
        const thumbName = `${baseName}-thumb.jpg`;
        const thumbPath = path.join(uploadDir, thumbName);

        await crearMiniaturaPixelada(archivo.path, thumbPath);

        const urlFull = `/uploads/${archivo.filename}`;
        const urlThumb = `/uploads/${thumbName}`;
        const fecha = new Date().toLocaleTimeString();
        const autor = (req.body?.autor || "").slice(0, 50) || "anon";

        const mensajeImagen = normalizarMensaje({
            id: generarMensajeId(),
            tipo: "imagen",
            autor,
            urlFull,
            urlThumb,
            fecha,
            nombreOriginal: archivo.originalname,
            mime: archivo.mimetype,
            size: archivo.size,
            reacciones: {},
        });

        mensajes.push(mensajeImagen);
        if (mensajes.length > MAX_MENSAJES) {
            mensajes.shift();
        }

        guardarMensajeEnDB(mensajeImagen);

        io.to("autorizados").emit("mensaje", mensajeImagen);

        return res.json({ urlFull, urlThumb, fecha });
    } catch (err) {
        console.error("[Upload] Error procesando imagen:", err.message);
        return res.status(500).json({ error: "Error procesando la imagen" });
    }
});

// Manejo simple de errores (multer, etc.)
app.use((err, _req, res, _next) => {
    console.error("[Error]", err.message);
    const esMulter = err.code === "LIMIT_FILE_SIZE" || err.message === "Tipo de archivo no permitido";
    const status = esMulter ? 400 : 500;
    const mensaje =
        err.code === "LIMIT_FILE_SIZE"
            ? `Archivo demasiado grande (max ${MAX_UPLOAD_MB}MB)`
            : err.message || "Error en el servidor";
    res.status(status).json({ error: mensaje });
});

// Funcion para generar un id anonimo corto a partir del socket.id
function generarIdAnonimo(socketId) {
    // Solo para agrupar mensajes / logs. NO se muestra al usuario como "nombre".
    return "anon-" + socketId.slice(0, 5);
}

io.on("connection", async (socket) => {
    const idAnonimo = generarIdAnonimo(socket.id);

    console.log(
        `${colors.cyan}[+] Nuevo socket conectado:${colors.reset} ${socket.id} (${idAnonimo})`
    );

    // Enviar al cliente su "identidad" anonima para que sepa cuales mensajes son suyos
    socket.emit("identidad", { autor: idAnonimo });

    let autorizado = false;

    socket.on("auth", async (payload = {}) => {
        if (autorizado) return;

        const claveRecibida = String(payload.password || "").trim();

        if (claveRecibida !== CLAVE_UNICA) {
            console.log(
                `${colors.red}[!] Clave incorrecta para el socket:${colors.reset} ${socket.id}`
            );
            socket.emit("auth-denegado");
            setTimeout(() => socket.disconnect(true), 300);
            return;
        }

        autorizado = true;
        socket.join("autorizados");
        socket.emit("auth-ok");

        const historial = await obtenerHistorial();
        socket.emit("historial", historial);
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
        console.log(`${colors.yellow}Autor anonimo:${colors.reset}`, idAnonimo);
        console.log(`${colors.yellow}CipherText:${colors.reset}`, data.cipherText);
        console.log(`${colors.yellow}IV:${colors.reset}`, data.iv);
        console.log(`${colors.yellow}Fecha:${colors.reset}`, data.fecha);
        console.log(`${colors.magenta}==============================================${colors.reset}`);

        const cipherText = data?.cipherText;
        const iv = data?.iv;
        const fecha = data?.fecha || new Date().toLocaleTimeString();

        if (!cipherText || !iv) {
            console.log("Mensaje invalido recibido (falta cipherText o iv).");
            return;
        }

        // El servidor NO sabe el texto original, solo reenvia y guarda cifrado
        const mensaje = normalizarMensaje({
            id: generarMensajeId(),
            tipo: "texto",
            autor: idAnonimo, // ID anonimo, NO es un nombre de usuario
            cipherText,
            iv,
            fecha,
            reacciones: {},
        });

        // Guardar el mensaje cifrado en el array en memoria
        mensajes.push(mensaje);
        if (mensajes.length > MAX_MENSAJES) {
            mensajes.shift();
        }

        // Guardar en DB si esta configurada
        guardarMensajeEnDB(mensaje);

        // Enviar el mensaje cifrado solo a clientes autorizados
        io.to("autorizados").emit("mensaje", mensaje);
    });

    socket.on("reaccion", async (payload = {}) => {
        if (!autorizado) {
            console.log(
                `${colors.red}[!] Socket no autorizado intentando reaccionar:${colors.reset} ${socket.id}`
            );
            return;
        }

        const mensajeId = String(payload.mensajeId || "").trim();
        const emoji = String(payload.emoji || "").trim();

        if (!mensajeId || !emoji || !EMOJIS_PERMITIDOS.includes(emoji)) {
            return;
        }

        const mensaje = buscarMensajePorId(mensajeId);
        if (!mensaje) return;

        const actuales = Array.isArray(mensaje.reacciones?.[emoji])
            ? [...mensaje.reacciones[emoji]]
            : [];
        const yaReacciono = actuales.includes(idAnonimo);

        const nuevoListado = yaReacciono
            ? actuales.filter((u) => u !== idAnonimo)
            : Array.from(new Set([...actuales, idAnonimo]));

        const reaccionesActualizadas = {
            ...mensaje.reacciones,
            [emoji]: nuevoListado,
        };

        for (const [k, lista] of Object.entries(reaccionesActualizadas)) {
            if (!Array.isArray(lista) || lista.length === 0) {
                delete reaccionesActualizadas[k];
            }
        }

        mensaje.reacciones = reaccionesActualizadas;

        if (MensajeModel) {
            const filtro = mensaje.messageId
                ? { $or: [{ messageId: mensaje.messageId }, { _id: mensaje.messageId }] }
                : { _id: mensaje.id };

            try {
                await MensajeModel.updateOne(filtro, {
                    reacciones: mensaje.reacciones,
                    messageId: mensaje.messageId || mensaje.id,
                });
            } catch (err) {
                console.error(colors.red, "[DB] Error guardando reacciones:", err.message, colors.reset);
            }
        }

        io.to("autorizados").emit("reaccion-actualizada", {
            mensajeId: mensaje.messageId || mensaje.id,
            reacciones: mensaje.reacciones,
        });
    });

    socket.on("disconnect", () => {
        console.log(
            `${colors.cyan}[-] Socket desconectado:${colors.reset} ${socket.id} (${idAnonimo})`
        );
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`${colors.green}Servidor corriendo en puerto:${colors.reset} ${PORT}`);
});
