import dotenv from "dotenv";
dotenv.config();
import { v4 as uuidv4 } from "uuid";
import express from "express";
import path from "path";
import fs from "fs";
import { addToRenderMediaQueue } from "./queues/workers/renderMedia";
import { createBullDashboardAndAttachRouter } from "./queues/dashboard";
import { state } from "./state";
import { RenderStatus, RenderMediaRequest, RenderMediaResponse, RenderStatusResponse } from "./types";

const app = express();
const outDirectory = `/tmp/out`;
const PORT = Number(process.env.PORT);
const remotionBundlePath = path.resolve("build");

if (!fs.existsSync(remotionBundlePath)) {
  throw new Error(
    "remotion bundle does not exist, run `npx remotion bundle` to create it",
  );
}

if (!fs.existsSync(outDirectory)) {
  fs.mkdirSync(outDirectory, { recursive: true });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve("build")));

createBullDashboardAndAttachRouter(app);

app.post("/render", async (req, res) => {
  const { compositionId, inputProps, serveUrl } = req.body as Partial<RenderMediaRequest>;

  if (!compositionId) {
    return res.status(400).json({ error: "missing compositionId" });
  }

  const renderId = uuidv4();
  const fileName = `${renderId}.mp4`;
  const outPath = `${outDirectory}/${fileName}`;

  try {
    await addToRenderMediaQueue({
      renderId,
      inputProps: inputProps ?? {},
      compositionId,
      outputLocation: outPath,
    });

    await state.prisma.renders.create({
      data: {
        uuid: renderId,
        status: RenderStatus.PENDING,
        output_location: outPath,
      },
    });

    const response: RenderMediaResponse = {
      message: "sent task for rendering",
      fileName,
    };

    res.status(200).json(response);
  } catch (err) {
    console.error("❌ failed to send task for rendering:", err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/status/:filename", async (req, res) => {
  const { filename } = req.params;
  const filePath = `${outDirectory}/${filename}`;

  try {
    const render = await state.prisma.renders.findFirst({
      where: { output_location: filePath },
    });

    if (!render) {
      return res.status(404).json({ error: "render not found" });
    }

    const fileExists = fs.existsSync(filePath);
    const status: RenderStatus = fileExists ? RenderStatus.COMPLETED : render.status as RenderStatus;

    const response: RenderStatusResponse = {
      status,
      fileName: filename,
      ...(status === RenderStatus.COMPLETED && {
        url: `/download/${filename}`,
      }),
    };

    res.status(200).json(response);
  } catch (err) {
    console.error("❌ failed to fetch render status:", err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/download/:filename", (req, res) => {
  const file = `${outDirectory}/${req.params.filename}`;

  if (!fs.existsSync(file)) {
    return res.status(404).send("file not found");
  }

  res.download(file);
});

app.listen(PORT, () => {
  console.log(`🌐 Static bundle: http://localhost:${PORT}`);
  console.log(`🎬 Render endpoint: POST http://localhost:${PORT}/render`);
  console.log(`📊 Status endpoint: GET http://localhost:${PORT}/status/:filename`);
  console.log(`⬇️  Download endpoint: GET http://localhost:${PORT}/download/:filename`);
});
