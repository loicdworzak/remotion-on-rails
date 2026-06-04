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
