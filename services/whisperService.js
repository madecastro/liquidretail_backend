const OpenAI = require('openai');
const { toFile } = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// OpenAI Whisper API supports mp3, mp4, mpeg, mpga, m4a, wav, webm.
// File size limit: 25MB. For larger videos, audio should be extracted first.
async function transcribeAudio(videoBuffer, filename = 'video.mp4') {
  if (videoBuffer.length > 25 * 1024 * 1024) {
    console.warn(`⚠️  Video is ${Math.round(videoBuffer.length / 1024 / 1024)}MB, exceeds Whisper 25MB limit. Skipping transcription.`);
    return null;
  }

  const file = await toFile(videoBuffer, filename);
  const result = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment']
  });

  return {
    text: result.text || '',
    duration: result.duration || 0,
    segments: (result.segments || []).map(s => ({
      id: s.id,
      start: s.start,
      end: s.end,
      text: s.text.trim()
    }))
  };
}

module.exports = { transcribeAudio };
