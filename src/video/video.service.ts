import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { AssemblyAI } from 'assemblyai';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';

ffmpeg.setFfmpegPath(ffmpegPath.path);

@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);

  constructor(private configService: ConfigService) {}

  async generateScript(prompt: string): Promise<any> {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not configured');
    }

    const ai = new GoogleGenAI({ apiKey });

    const fullPrompt = `You are a Video Script Writer and AI Image Prompt Engineer. You do all the tasks with sincerity.\n\n${prompt}`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: fullPrompt,
      config: {
        temperature: 0.5,
        topP: 0.95,
        maxOutputTokens: 2048,
      },
    });

    if (!response || !response.candidates || response.candidates.length === 0) {
      throw new Error('No content generated');
    }

    const candidate = response.candidates[0];
    if (!candidate || !candidate.content || !candidate.content.parts) {
      throw new Error('Invalid response structure');
    }

    const textPart = candidate.content.parts.find((part) => part.text);

    if (!textPart || !textPart.text) {
      throw new Error('No text in response');
    }

    let content = textPart.text.trim();

    if (content.startsWith('```json')) {
      content = content.replace(/^```json\s*/, '').replace(/```\s*$/, '');
    } else if (content.startsWith('```')) {
      content = content.replace(/^```\s*/, '').replace(/```\s*$/, '');
    }

    return JSON.parse(content);
  }

  async generateAudio(text: string): Promise<{ audio: string; contentType: string }> {
    const apiKey = this.configService.get<string>('ELEVENLABS_API_KEY');
    if (!apiKey) {
      throw new Error('ELEVENLABS_API_KEY not configured');
    }

    const voiceId = '21m00Tcm4TlvDq8ikWAM';

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          Accept: 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5,
          },
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
    }

    const audioBuffer = await response.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuffer).toString('base64');

    return {
      audio: audioBase64,
      contentType: 'audio/mpeg',
    };
  }

  async generateImage(prompt: string): Promise<{ image: string; contentType: string }> {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not configured');
    }

    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: prompt,
    });

    if (!response || !response.candidates || response.candidates.length === 0) {
      throw new Error('No image generated');
    }

    const candidate = response.candidates[0];
    if (!candidate || !candidate.content || !candidate.content.parts) {
      throw new Error('Invalid response structure');
    }

    const parts = candidate.content.parts;
    const imagePart = parts.find((part) => part.inlineData);

    if (!imagePart || !imagePart.inlineData || !imagePart.inlineData.data) {
      throw new Error('No image in response');
    }

    return {
      image: imagePart.inlineData.data,
      contentType: imagePart.inlineData.mimeType || 'image/png',
    };
  }

  async generateImages(prompts: string[]): Promise<{ images: string[]; contentType: string }> {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not configured');
    }

    const ai = new GoogleGenAI({ apiKey });
    const images: string[] = [];

    for (const prompt of prompts) {
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash-image',
          contents: prompt,
        });

        if (response && response.candidates && response.candidates.length > 0) {
          const candidate = response.candidates[0];

          if (candidate && candidate.content && candidate.content.parts) {
            const parts = candidate.content.parts;
            const imagePart = parts.find((part) => part.inlineData);

            if (imagePart && imagePart.inlineData && imagePart.inlineData.data) {
              images.push(imagePart.inlineData.data);
            } else {
              this.logger.error(`No image generated for: ${prompt}`);
              images.push('');
            }
          } else {
            this.logger.error(`Invalid response structure for: ${prompt}`);
            images.push('');
          }
        } else {
          this.logger.error(`No candidates for: ${prompt}`);
          images.push('');
        }
      } catch (error) {
        this.logger.error(`Error generating image for prompt: ${prompt}`, error);
        images.push('');
      }
    }

    return {
      images,
      contentType: 'image/png',
    };
  }

  async generateCaptions(audioFileUrl: string): Promise<any[]> {
    const apiKey = this.configService.get<string>('ASSEMBLYAI_API_KEY');
    if (!apiKey) {
      throw new Error('ASSEMBLYAI_API_KEY not configured');
    }

    const client = new AssemblyAI({ apiKey });

    const transcript = await client.transcripts.transcribe({
      audio: audioFileUrl,
    });

    if (!transcript.words) {
      throw new Error('No captions generated');
    }

    return transcript.words.map((word) => ({
      text: word.text,
      start: word.start,
      end: word.end,
      confidence: word.confidence,
    }));
  }

  async renderVideo(
    audioUrl: string,
    images: string[],
    duration: number,
  ): Promise<{ video: string; contentType: string; size: number }> {
    const sessionId = uuidv4();
    const tempDir = join(os.tmpdir(), `video-${sessionId}`);

    try {
      this.logger.log(`[${sessionId}] Starting render: ${images.length} images, ${duration}s duration`);

      if (!existsSync(tempDir)) {
        await mkdir(tempDir, { recursive: true });
      }

      this.logger.log(`[${sessionId}] Processing audio...`);
      const audioPath = join(tempDir, 'audio.mp3');

      if (this.isDataUrl(audioUrl)) {
        const audioBuffer = this.decodeDataUrl(audioUrl);
        await writeFile(audioPath, audioBuffer);
      } else {
        const audioResponse = await fetch(audioUrl);
        if (!audioResponse.ok) {
          throw new Error(`Failed to download audio: ${audioResponse.status}`);
        }
        const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
        await writeFile(audioPath, audioBuffer);
      }

      this.logger.log(`[${sessionId}] Processing ${images.length} images...`);
      const imagePaths: string[] = [];

      for (let i = 0; i < images.length; i++) {
        const imagePath = join(tempDir, `image_${String(i).padStart(3, '0')}.png`);

        try {
          if (this.isDataUrl(images[i])) {
            const imageBuffer = this.decodeDataUrl(images[i]);
            await writeFile(imagePath, imageBuffer);
          } else {
            const imageResponse = await fetch(images[i]);
            if (!imageResponse.ok) {
              this.logger.error(`Failed to download image ${i}: ${imageResponse.status}`);
              continue;
            }
            const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
            await writeFile(imagePath, imageBuffer);
          }
          imagePaths.push(imagePath);
        } catch (error) {
          this.logger.error(`Error processing image ${i}:`, error);
          continue;
        }
      }

      if (imagePaths.length === 0) {
        throw new Error('No images were processed successfully');
      }

      this.logger.log(`[${sessionId}] Processed ${imagePaths.length} images successfully`);

      const filelistPath = join(tempDir, 'filelist.txt');
      const imageDuration = duration / imagePaths.length;
      let filelistContent = '';

      for (let i = 0; i < imagePaths.length; i++) {
        const normalizedPath = imagePaths[i].replace(/\\/g, '/');
        filelistContent += `file '${normalizedPath}'\n`;
        filelistContent += `duration ${imageDuration.toFixed(3)}\n`;
      }
      const lastImagePath = imagePaths[imagePaths.length - 1].replace(/\\/g, '/');
      filelistContent += `file '${lastImagePath}'\n`;

      await writeFile(filelistPath, filelistContent);
      this.logger.log(`[${sessionId}] Created concat file with ${imagePaths.length} images, ${imageDuration.toFixed(2)}s each`);

      const outputPath = join(tempDir, 'output.mp4');

      this.logger.log(`[${sessionId}] Starting FFmpeg render...`);

      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(filelistPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .input(audioPath)
          .outputOptions([
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-tune', 'stillimage',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=1280:1080:force_original_aspect_ratio=decrease,pad=1280:1080:(ow-iw)/2:(oh-ih)/2',
            '-shortest',
            '-movflags', '+faststart',
          ])
          .output(outputPath)
          .on('start', (commandLine) => {
            this.logger.log(`[${sessionId}] FFmpeg command: ${commandLine}`);
          })
          .on('progress', (progress) => {
            if (progress.percent) {
              this.logger.log(`[${sessionId}] Processing: ${progress.percent.toFixed(1)}% done`);
            }
          })
          .on('end', () => {
            this.logger.log(`[${sessionId}] FFmpeg render completed`);
            resolve();
          })
          .on('error', (err) => {
            this.logger.error(`[${sessionId}] FFmpeg error:`, err);
            reject(err);
          })
          .run();
      });

      this.logger.log(`[${sessionId}] Reading output file...`);
      const videoBuffer = await readFile(outputPath);
      const videoBase64 = videoBuffer.toString('base64');

      this.logger.log(`[${sessionId}] Video size: ${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB`);

      this.logger.log(`[${sessionId}] Cleaning up...`);
      try {
        await unlink(audioPath);
        await unlink(filelistPath);
        await unlink(outputPath);
        for (const path of imagePaths) {
          await unlink(path);
        }
      } catch (cleanupError) {
        this.logger.error(`[${sessionId}] Cleanup error:`, cleanupError);
      }

      this.logger.log(`[${sessionId}] Render complete!`);

      return {
        video: videoBase64,
        contentType: 'video/mp4',
        size: videoBuffer.length,
      };
    } catch (error) {
      this.logger.error(`[${sessionId}] Render error:`, error);
      throw error;
    }
  }

  private isDataUrl(url: string): boolean {
    return url.startsWith('data:');
  }

  private decodeDataUrl(dataUrl: string): Buffer {
    const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error('Invalid data URL format');
    }
    return Buffer.from(matches[2], 'base64');
  }
}