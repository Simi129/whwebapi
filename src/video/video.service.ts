import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { AssemblyAI } from 'assemblyai';
import { createClient } from '@supabase/supabase-js';
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
  private supabase;

  constructor(private configService: ConfigService) {
    // Инициализация Supabase клиента
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    // Пробуем сначала SUPABASE_KEY, потом SUPABASE_SERVICE_ROLE_KEY для обратной совместимости
    const supabaseKey = 
      this.configService.get<string>('SUPABASE_KEY') || 
      this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    
    if (supabaseUrl && supabaseKey) {
      this.supabase = createClient(supabaseUrl, supabaseKey);
      this.logger.log('✅ Supabase client initialized');
    } else {
      this.logger.warn('⚠️ Supabase not configured - SUPABASE_URL or SUPABASE_KEY missing');
    }
  }

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
    const apiKey = this.configService.get<string>('GOOGLE_CLOUD_TTS_API_KEY');
    if (!apiKey) {
      throw new Error('GOOGLE_CLOUD_TTS_API_KEY not configured');
    }

    this.logger.log(`Generating audio with Google Cloud TTS (${text.length} characters)`);

    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: {
            text: text,
          },
          voice: {
            languageCode: 'en-US',
            name: 'en-US-Neural2-F', // Женский голос, естественный
            // Другие варианты:
            // en-US-Neural2-D - Мужской, уверенный
            // en-US-Neural2-C - Женский, профессиональный
            // en-US-Neural2-A - Мужской, энергичный
            // en-GB-Neural2-A - Британский женский
            // en-GB-Neural2-B - Британский мужской
            ssmlGender: 'FEMALE', // MALE или FEMALE
          },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: 1.0, // 0.25-4.0 (скорость речи)
            pitch: 0.0,        // -20.0 to 20.0 (тон)
            volumeGainDb: 0.0, // -96.0 to 16.0 (громкость)
          },
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google Cloud TTS API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    if (!data.audioContent) {
      throw new Error('No audio content in response');
    }

    // Google возвращает base64 напрямую
    const audioBase64 = data.audioContent;

    this.logger.log(`Audio generated successfully: ${(audioBase64.length * 0.75 / 1024).toFixed(2)} KB`);

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

  /**
   * ОПТИМИЗИРОВАННЫЙ МЕТОД: Рендеринг видео по ID
   * Загружает данные из Supabase вместо получения их в запросе
   */
  async renderVideoById(videoId: string): Promise<{ video: string; contentType: string; size: number }> {
    const sessionId = uuidv4();
    
    try {
      this.logger.log(`[${sessionId}] Starting render for video ID: ${videoId}`);

      if (!this.supabase) {
        throw new Error('Supabase not configured');
      }

      // Загружаем данные видео из Supabase
      this.logger.log(`[${sessionId}] Fetching video data from Supabase...`);
      const { data: videoData, error } = await this.supabase
        .from('video_data')
        .select('*')
        .eq('id', videoId)
        .single();

      if (error || !videoData) {
        throw new Error(`Video not found: ${videoId}`);
      }

      this.logger.log(`[${sessionId}] Video data loaded: ${videoData.image_list?.length || 0} images, ${videoData.duration}s`);

      // Вызываем стандартный метод рендеринга с данными из БД
      return await this.renderVideo(
        videoData.audio_file_url,
        videoData.image_list || [],
        videoData.duration || 30,
        sessionId,
      );
    } catch (error) {
      this.logger.error(`[${sessionId}] Render error for video ${videoId}:`, error);
      throw error;
    }
  }

  /**
   * Стандартный метод рендеринга (для обратной совместимости)
   */
  async renderVideo(
    audioUrl: string,
    images: string[],
    duration: number,
    sessionId?: string,
  ): Promise<{ video: string; contentType: string; size: number }> {
    const session = sessionId || uuidv4();
    const tempDir = join(os.tmpdir(), `video-${session}`);

    try {
      this.logger.log(`[${session}] Starting render: ${images.length} images, ${duration}s duration`);

      if (!existsSync(tempDir)) {
        await mkdir(tempDir, { recursive: true });
      }

      // Обработка аудио
      this.logger.log(`[${session}] Processing audio...`);
      const audioPath = join(tempDir, 'audio.mp3');
      await this.downloadFile(audioUrl, audioPath, session);

      // Обработка изображений
      this.logger.log(`[${session}] Processing ${images.length} images...`);
      const imagePaths: string[] = [];

      // Используем Promise.all для параллельной загрузки (оптимизация!)
      await Promise.all(
        images.map(async (imageUrl, i) => {
          const imagePath = join(tempDir, `image_${String(i).padStart(3, '0')}.png`);
          try {
            await this.downloadFile(imageUrl, imagePath, session);
            imagePaths[i] = imagePath;
          } catch (error) {
            this.logger.error(`[${session}] Error processing image ${i}:`, error);
          }
        })
      );

      // Фильтруем только успешно загруженные изображения
      const validImagePaths = imagePaths.filter(Boolean);

      if (validImagePaths.length === 0) {
        throw new Error('No images were processed successfully');
      }

      this.logger.log(`[${session}] Processed ${validImagePaths.length} images successfully`);

      // Создаём concat файл для FFmpeg
      const filelistPath = join(tempDir, 'filelist.txt');
      const imageDuration = duration / validImagePaths.length;
      let filelistContent = '';

      for (let i = 0; i < validImagePaths.length; i++) {
        const normalizedPath = validImagePaths[i].replace(/\\/g, '/');
        filelistContent += `file '${normalizedPath}'\n`;
        filelistContent += `duration ${imageDuration.toFixed(3)}\n`;
      }
      const lastImagePath = validImagePaths[validImagePaths.length - 1].replace(/\\/g, '/');
      filelistContent += `file '${lastImagePath}'\n`;

      await writeFile(filelistPath, filelistContent);
      this.logger.log(`[${session}] Created concat file with ${validImagePaths.length} images, ${imageDuration.toFixed(2)}s each`);

      const outputPath = join(tempDir, 'output.mp4');

      this.logger.log(`[${session}] Starting FFmpeg render...`);

      // Рендеринг видео с оптимизированными настройками
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(filelistPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .input(audioPath)
          .outputOptions([
            '-c:v', 'libx264',
            '-preset', 'faster', // Быстрее чем 'medium', но хорошее качество
            '-tune', 'stillimage',
            '-crf', '23', // Качество (18-28, где 23 = хороший баланс)
            '-c:a', 'aac',
            '-b:a', '128k', // Снизили с 192k (экономия размера)
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=1280:1080:force_original_aspect_ratio=decrease,pad=1280:1080:(ow-iw)/2:(oh-ih)/2',
            '-shortest',
            '-movflags', '+faststart', // Оптимизация для веб-плеера
          ])
          .output(outputPath)
          .on('start', (commandLine) => {
            this.logger.log(`[${session}] FFmpeg command: ${commandLine}`);
          })
          .on('progress', (progress) => {
            if (progress.percent) {
              this.logger.log(`[${session}] Processing: ${progress.percent.toFixed(1)}% done`);
            }
          })
          .on('end', () => {
            this.logger.log(`[${session}] FFmpeg render completed`);
            resolve();
          })
          .on('error', (err) => {
            this.logger.error(`[${session}] FFmpeg error:`, err);
            reject(err);
          })
          .run();
      });

      this.logger.log(`[${session}] Reading output file...`);
      const videoBuffer = await readFile(outputPath);
      const videoBase64 = videoBuffer.toString('base64');

      this.logger.log(`[${session}] Video size: ${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB`);

      // Cleanup
      this.logger.log(`[${session}] Cleaning up...`);
      try {
        await unlink(audioPath);
        await unlink(filelistPath);
        await unlink(outputPath);
        for (const path of validImagePaths) {
          if (path) await unlink(path);
        }
      } catch (cleanupError) {
        this.logger.error(`[${session}] Cleanup error:`, cleanupError);
      }

      this.logger.log(`[${session}] Render complete!`);

      return {
        video: videoBase64,
        contentType: 'video/mp4',
        size: videoBuffer.length,
      };
    } catch (error) {
      this.logger.error(`[${session}] Render error:`, error);
      throw error;
    }
  }

  /**
   * Вспомогательный метод для загрузки файлов
   */
  private async downloadFile(url: string, outputPath: string, sessionId: string): Promise<void> {
    if (this.isDataUrl(url)) {
      const buffer = this.decodeDataUrl(url);
      await writeFile(outputPath, buffer);
    } else {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(outputPath, buffer);
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