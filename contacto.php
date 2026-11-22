<?php
// Formulario de contacto de aguilarealmexicana.org
// Envía por el SMTP de IONOS (smtp.ionos.mx, 587, STARTTLS + AUTH LOGIN).
// Las credenciales NO van en el repositorio: se leen de ../config_correo.php,
// fuera de la carpeta pública (ver config_correo.ejemplo.php).

declare(strict_types=1);

const PAGINA = 'contacto.html';

$temas_validos = [
    'donativo'     => 'Donativo',
    'memoria'      => 'Donativo en memoria o en honor',
    'equipo'       => 'Donación de equipo de campo',
    'patrocinio'   => 'Patrocinio empresarial',
    'colaboracion' => 'Colaboración',
    'prensa'       => 'Prensa',
    'otro'         => 'Otro',
];

function volver(string $estado): void {
    header('Location: ' . PAGINA . '?estado=' . $estado, true, 303);
    exit;
}

function limpio(string $texto): string {
    // Quita saltos de línea para evitar inyección de cabeceras
    return trim(str_replace(["\r", "\n"], ' ', $texto));
}

// Lee una respuesta SMTP completa (incluye líneas multilínea "250-...")
function smtp_leer($sock): array {
    $codigo = 0;
    $texto = '';
    while (($linea = fgets($sock, 2048)) !== false) {
        $codigo = (int)substr($linea, 0, 3);
        $texto .= $linea;
        if (strlen($linea) < 4 || $linea[3] === ' ') break;
    }
    return [$codigo, $texto];
}

function smtp_orden($sock, string $orden, array $esperados): bool {
    fwrite($sock, $orden . "\r\n");
    [$codigo, $texto] = smtp_leer($sock);
    if (!in_array($codigo, $esperados, true)) {
        error_log('SMTP contacto: "' . explode(' ', $orden)[0] . '" respondió ' . $codigo . ' ' . trim($texto));
        return false;
    }
    return true;
}

function smtp_enviar(array $cfg, string $de, string $para, string $mensaje): bool {
    $sock = @stream_socket_client('tcp://' . $cfg['host'] . ':' . $cfg['puerto'], $errno, $errstr, 20);
    if (!$sock) {
        error_log("SMTP contacto: no se conectó ($errno $errstr)");
        return false;
    }
    stream_set_timeout($sock, 20);
    try {
        [$codigo] = smtp_leer($sock);
        if ($codigo !== 220) return false;

        if (!smtp_orden($sock, 'EHLO aguilarealmexicana.org', [250])) return false;
        if (!smtp_orden($sock, 'STARTTLS', [220])) return false;
        if (!stream_socket_enable_crypto($sock, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
            error_log('SMTP contacto: falló el cifrado TLS');
            return false;
        }
        if (!smtp_orden($sock, 'EHLO aguilarealmexicana.org', [250])) return false;

        // AUTH LOGIN
        if (!smtp_orden($sock, 'AUTH LOGIN', [334])) return false;
        if (!smtp_orden($sock, base64_encode($cfg['usuario']), [334])) return false;
        if (!smtp_orden($sock, base64_encode($cfg['contrasena']), [235])) return false;

        if (!smtp_orden($sock, 'MAIL FROM:<' . $de . '>', [250])) return false;
        if (!smtp_orden($sock, 'RCPT TO:<' . $para . '>', [250, 251])) return false;
        if (!smtp_orden($sock, 'DATA', [354])) return false;

        // Normaliza saltos a CRLF y hace dot-stuffing
        $lineas = preg_split('/\r\n|\r|\n/', $mensaje);
        $cuerpo = '';
        foreach ($lineas as $linea) {
            if (isset($linea[0]) && $linea[0] === '.') $linea = '.' . $linea;
            $cuerpo .= $linea . "\r\n";
        }
        fwrite($sock, $cuerpo . ".\r\n");
        [$codigo, $texto] = smtp_leer($sock);
        if ($codigo !== 250) {
            error_log('SMTP contacto: el mensaje fue rechazado ' . $codigo . ' ' . trim($texto));
            return false;
        }
        fwrite($sock, "QUIT\r\n");
        return true;
    } finally {
        fclose($sock);
    }
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit('Método no permitido.');
}

// Campo trampa: los humanos no lo llenan
if (!empty($_POST['sitio_web'] ?? '')) {
    volver('ok');
}

$ruta_config = __DIR__ . '/../config_correo.php';
if (!is_file($ruta_config)) {
    error_log('SMTP contacto: falta config_correo.php fuera de la carpeta pública');
    volver('error');
}
$cfg = require $ruta_config;

$nombre  = limpio((string)($_POST['nombre'] ?? ''));
$correo  = limpio((string)($_POST['correo'] ?? ''));
$tema    = (string)($_POST['tema'] ?? '');
$mensaje = trim((string)($_POST['mensaje'] ?? ''));

if ($nombre === '' || mb_strlen($nombre) > 100) volver('error');
if (!filter_var($correo, FILTER_VALIDATE_EMAIL) || mb_strlen($correo) > 150) volver('error');
if (!array_key_exists($tema, $temas_validos)) volver('error');
if ($mensaje === '' || mb_strlen($mensaje) > 3000) volver('error');

$de      = $cfg['remitente'];       // debe coincidir con el buzón autenticado
$para    = $cfg['destino'];
$asunto  = '[Sitio] ' . $temas_validos[$tema] . ' — ' . $nombre;
$cuerpo  = "Nombre: $nombre\n"
         . "Correo: $correo\n"
         . "Tema: " . $temas_validos[$tema] . "\n"
         . "IP: " . ($_SERVER['REMOTE_ADDR'] ?? 'desconocida') . "\n\n"
         . $mensaje . "\n";

$cabeceras = "From: Águila Real Mexicana <$de>\r\n"
           . "To: <$para>\r\n"
           . "Reply-To: $nombre <$correo>\r\n"
           . "Subject: =?UTF-8?B?" . base64_encode($asunto) . "?=\r\n"
           . "Date: " . date('r') . "\r\n"
           . "MIME-Version: 1.0\r\n"
           . "Content-Type: text/plain; charset=UTF-8\r\n"
           . "Content-Transfer-Encoding: 8bit\r\n";

$enviado = smtp_enviar($cfg, $de, $para, $cabeceras . "\r\n" . $cuerpo);

volver($enviado ? 'ok' : 'error');
