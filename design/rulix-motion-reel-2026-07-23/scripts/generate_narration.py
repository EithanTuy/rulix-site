import asyncio
import json
from pathlib import Path

import edge_tts


ROOT = Path(__file__).resolve().parent.parent
VOICE = "en-US-MichelleNeural"
RATE = "-8%"


async def main() -> None:
    text = (ROOT / "narration.txt").read_text(encoding="utf-8").strip()
    audio_path = ROOT / "narration.mp3"
    transcript_path = ROOT / "transcript.json"
    words: list[dict[str, float | str]] = []

    with audio_path.open("wb") as audio:
        async for chunk in edge_tts.Communicate(
            text=text,
            voice=VOICE,
            rate=RATE,
            boundary="WordBoundary",
        ).stream():
            if chunk["type"] == "audio":
                audio.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                start = chunk["offset"] / 10_000_000
                duration = chunk["duration"] / 10_000_000
                words.append(
                    {
                        "text": chunk["text"],
                        "start": round(start, 3),
                        "end": round(start + duration, 3),
                    }
                )

    transcript_path.write_text(
        json.dumps(words, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    asyncio.run(main())
