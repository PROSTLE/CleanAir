import { NextResponse } from "next/server";

const IMGBB_UPLOAD_URL = "https://api.imgbb.com/1/upload";
const MAX_DATA_URL_CHARS = 750_000;

interface ImgBBResponse {
  data?: {
    display_url?: string;
    url?: string;
  };
  error?: {
    message?: string;
  };
  success?: boolean;
}

function getBase64Payload(dataUrl: string) {
  const marker = ";base64,";
  const markerIndex = dataUrl.indexOf(marker);
  if (markerIndex === -1) return dataUrl;
  return dataUrl.slice(markerIndex + marker.length);
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.IMGBB_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "ImgBB is not configured." }, { status: 500 });
    }

    const body = (await request.json()) as { image?: string; name?: string };
    const image = body.image ?? "";
    if (!image) {
      return NextResponse.json({ error: "Missing image." }, { status: 400 });
    }
    if (image.length > MAX_DATA_URL_CHARS) {
      return NextResponse.json(
        { error: "Image is too large after compression." },
        { status: 413 },
      );
    }

    const formData = new FormData();
    formData.set("key", apiKey);
    formData.set("image", getBase64Payload(image));
    if (body.name) formData.set("name", body.name);

    const response = await fetch(IMGBB_UPLOAD_URL, {
      body: formData,
      method: "POST",
    });
    const result = (await response.json()) as ImgBBResponse;

    if (!response.ok || !result.success) {
      return NextResponse.json(
        { error: result.error?.message ?? "ImgBB upload failed." },
        { status: response.ok ? 502 : response.status },
      );
    }

    const imageUrl = result.data?.display_url ?? result.data?.url;
    if (!imageUrl) {
      return NextResponse.json(
        { error: "ImgBB did not return an image URL." },
        { status: 502 },
      );
    }

    return NextResponse.json({ imageUrl });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown upload error." },
      { status: 500 },
    );
  }
}
