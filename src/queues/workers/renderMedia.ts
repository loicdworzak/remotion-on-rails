import { Job, JobsOptions } from "bullmq";
import { createQueue, createWorker } from "../factory";
import { RenderMediaRequest, RenderStatus } from "../../types";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { state } from "../../state";

const queueName = "RENDER_MEDIA";

const queue = createQueue(queueName);

const worker = createWorker(queueName, async (job: Job) => {
  const data = job.data as RenderMediaRequest;

  const serveUrl = data.serveUrl ?? `http://localhost:${process.env.PORT}`;

  const composition = await selectComposition({
    inputProps: data.inputProps,
    id: data.compositionId,
    serveUrl,
  });

  await renderMedia({
    outputLocation: data.outputLocation,
    inputProps: data.inputProps,
    composition: composition,
    codec: "h264",
    serveUrl,
    // ---- QUALITÉ MAX ----
  imageFormat: "png",   // frames SANS PERTE (clé n°1 : supprime les artefacts JPEG)
  crf: 14,              // 1=quasi-master/lourd, 18=très bon. 12-16 = sweet spot UI
  x264Preset: "slower", // meilleure compression à qualité égale
  scale: 1,             // supersampling : rend en 4K interne puis redescend en 1080p → texte ultra net
  concurrency: null,    // utilise tous les cœurs CPU dispo
  });

  await state.prisma.renders.update({
    where: { uuid: data.renderId },
    data: { status: RenderStatus.COMPLETED },
  });

});

const addToRenderMediaQueue = (
  data: RenderMediaRequest,
  options?: JobsOptions | undefined,
) => {
  const jobName = `${queueName}`;
  return queue.add(jobName, data, options);
};

export { queue, worker, addToRenderMediaQueue };
