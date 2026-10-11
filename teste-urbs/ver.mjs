import pkg from "xz-decompress";
const { XzReadableStream } = pkg;
import readline from "node:readline";
import { Readable } from "node:stream";

const r = await fetch("http://dadosabertos.c3sl.ufpr.br/curitibaurbs/2026_10_10_veiculos.json.xz");
const rl = readline.createInterface({ input: Readable.fromWeb(new XzReadableStream(r.body)) });

const conv = (s) => { const [d, h] = s.split(" "); const [dd, mm, aa] = d.split("/"); return new Date(`${aa}-${mm}-${dd}T${h}`).getTime(); };
let anterior = null, trocas = 0, juntos = true, decresc = 0, cresc = 0, n = 0;
const vistos = new Set();
for await (const linha of rl) {
  if (!linha.trim()) continue;
  const v = JSON.parse(linha);
  if (anterior && anterior.VEIC === v.VEIC) {
    conv(v.DTHR) < conv(anterior.DTHR) ? decresc++ : cresc++;
  } else {
    if (vistos.has(v.VEIC)) juntos = false;
    vistos.add(v.VEIC);
    trocas++;
  }
  anterior = v;
  if (++n >= 600000) break;
}
console.log({ amostra: n, trocasDeVeiculo: trocas, veiculosSempreJuntos: juntos, decrescente: decresc, crescente: cresc });
