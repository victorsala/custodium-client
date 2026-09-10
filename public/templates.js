// templates.js — plantilles d'element per a "Nuevo elemento".
//
// Només client, sense xarxa. Triar-ne una omple el títol (si és buit) i les
// instruccions; el titular ho edita lliurement. Per afegir-ne una, afegeix
// un objecte { id, name, title, notes } aquí (name és el text del
// desplegable): app.js no cal tocar-lo.

export const TEMPLATES = [
  {
    id: "bank",
    name: "Cuenta bancaria",
    title: "Cuenta bancaria en …",
    notes: [
      "Entidad: …",
      "Titular o titulares: …",
      "IBAN (o últimos 4 dígitos): …",
      "Dónde están las claves de acceso (banca online, tarjetas): …",
      "Gestor o persona de contacto en la entidad: …",
      "Qué hay que hacer con esta cuenta (mantener, cancelar, transferir a …): …",
      "Domiciliaciones importantes que dependen de ella: …",
    ].join("\n"),
  },
  {
    id: "wallet",
    name: "Wallet de criptoactivos",
    title: "Wallet …",
    notes: [
      "Qué wallet es (hardware, app, exchange) y qué activos hay: …",
      "Dónde está la seed en papel (mejor no la escribas aquí): …",
      "Si hay passphrase adicional, dónde está y quién la conoce: …",
      "Cómo se restaura (modelo del dispositivo, app, pasos): …",
      "Con quién contar si hace falta ayuda técnica: …",
      "Qué hay que hacer con estos activos: …",
    ].join("\n"),
  },
  {
    id: "social",
    name: "Redes sociales",
    title: "Cuenta de … en …",
    notes: [
      "Red social y nombre de usuario (o enlace al perfil): …",
      "Correo o teléfono con el que se creó la cuenta: …",
      "Contraseña, o dónde está guardada (gestor de contraseñas): …",
      "Verificación en dos pasos: qué método y dónde están los códigos de recuperación: …",
      "Qué hay que hacer con la cuenta (cerrarla, convertirla en conmemorativa, mantenerla, publicar un último mensaje): …",
      "Contacto de legado o heredero configurado en la plataforma, si lo hay: …",
    ].join("\n"),
  },
  {
    id: "insurance",
    name: "Seguro o póliza",
    title: "Seguro de … con …",
    notes: [
      "Compañía y tipo de seguro: …",
      "Número de póliza: …",
      "Beneficiarios designados: …",
      "Dónde está el contrato o la póliza: …",
      "Contacto (agente, teléfono, correo): …",
      "Plazo para reclamar y documentación que suele pedirse: …",
    ].join("\n"),
  },
];
