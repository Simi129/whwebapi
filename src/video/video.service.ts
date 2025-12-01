import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { AssemblyAI } from 'assemblyai';
import { createClient } from '@supabase/supabase-js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import ffprobePath from '@ffprobe-installer/ffprobe';
import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';

ffmpeg.setFfmpegPath(ffmpegPath.path);
ffmpeg.setFfprobePath(ffprobePath.path);

@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);
  private supabase;

  constructor(private configService: ConfigService) {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
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
            name: 'en-US-Neural2-F',
            ssmlGender: 'FEMALE',
          },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: 1.0,
            pitch: 0.0,
            volumeGainDb: 0.0,
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
   * 🔧 ИСПРАВЛЕННЫЙ МЕТОД: Рендеринг видео по ID с поддержкой субтитров
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

      this.logger.log(`[${sessionId}] Video data loaded: ${videoData.image_list?.length || 0} images, show_captions: ${videoData.show_captions}`);

      // 🔧 ИСПРАВЛЕНИЕ: Передаем captions и show_captions в метод рендеринга
      return await this.renderVideo(
        videoData.audio_file_url,
        videoData.image_list || [],
        videoData.captions || [], // ✅ Передаем субтитры
        videoData.show_captions !== false, // ✅ Передаем флаг (по умолчанию true)
        sessionId,
      );
    } catch (error) {
      this.logger.error(`[${sessionId}] Render error for video ${videoId}:`, error);
      throw error;
    }
  }

  /**
   * 🔧 ИСПРАВЛЕННЫЙ МЕТОД: Рендеринг с субтитрами и правильной длительностью
   */
  async renderVideo(
    audioUrl: string,
    images: string[],
    captions: any[], // ✅ Добавлен параметр
    showCaptions: boolean = true, // ✅ Добавлен параметр
    sessionId?: string,
  ): Promise<{ video: string; contentType: string; size: number }> {
    const session = sessionId || uuidv4();
    const tempDir = join(os.tmpdir(), `video-${session}`);

    try {
      this.logger.log(`[${session}] Starting render: ${images.length} images, captions: ${showCaptions}`);

      if (!existsSync(tempDir)) {
        await mkdir(tempDir, { recursive: true });
      }

      // Обработка аудио
      this.logger.log(`[${session}] Processing audio...`);
      const audioPath = join(tempDir, 'audio.mp3');
      await this.downloadFile(audioUrl, audioPath, session);

      // 🔧 ИСПРАВЛЕНИЕ: Получаем РЕАЛЬНУЮ длительность аудио
      const audioDuration = await this.getAudioDuration(audioPath, session);
      this.logger.log(`[${session}] Audio duration: ${audioDuration.toFixed(2)}s`);

      // Обработка изображений
      this.logger.log(`[${session}] Processing ${images.length} images...`);
      const imagePaths: string[] = [];

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

      const validImagePaths = imagePaths.filter(Boolean);

      if (validImagePaths.length === 0) {
        throw new Error('No images were processed successfully');
      }

      this.logger.log(`[${session}] Processed ${validImagePaths.length} images successfully`);

      // Создаём concat файл для FFmpeg
      const filelistPath = join(tempDir, 'filelist.txt');
      // 🔧 ИСПРАВЛЕНИЕ: Используем РЕАЛЬНУЮ длительность аудио
      const imageDuration = audioDuration / validImagePaths.length;
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

      // 🔧 НОВОЕ: Генерация SRT файла для субтитров (если включены)
      let subtitlesPath: string | null = null;
      if (showCaptions && captions && captions.length > 0) {
        subtitlesPath = join(tempDir, 'subtitles.srt');
        await this.generateSrtFile(captions, subtitlesPath);
        this.logger.log(`[${session}] Generated SRT file with ${captions.length} captions`);
      }

      const outputPath = join(tempDir, 'output.mp4');

      this.logger.log(`[${session}] Starting FFmpeg render...`);

      // 🔧 ИСПРАВЛЕНИЕ: Рендеринг с субтитрами
      await new Promise<void>((resolve, reject) => {
        const ffmpegCommand = ffmpeg()
          .input(filelistPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .input(audioPath);

        // Базовые опции вывода
        const outputOptions = [
          '-c:v', 'libx264',
          '-preset', 'faster',
          '-tune', 'stillimage',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-pix_fmt', 'yuv420p',
          '-shortest',
          '-movflags', '+faststart',
        ];

        // 🔧 НОВОЕ: Добавляем субтитры через фильтр (если включены)
        if (subtitlesPath) {
          // Нормализуем путь для FFmpeg (Windows compatibility)
          const normalizedSubPath = subtitlesPath.replace(/\\/g, '/').replace(/:/g, '\\:');
          outputOptions.push(
            '-vf',
            `scale=1280:1080:force_original_aspect_ratio=decrease,pad=1280:1080:(ow-iw)/2:(oh-ih)/2,subtitles='${normalizedSubPath}':force_style='FontName=Arial,FontSize=24,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=3,Outline=2,Shadow=1,MarginV=50'`
          );
        } else {
          // Без субтитров - просто масштабирование
          outputOptions.push(
            '-vf',
            'scale=1280:1080:force_original_aspect_ratio=decrease,pad=1280:1080:(ow-iw)/2:(oh-ih)/2'
          );
        }

        ffmpegCommand
          .outputOptions(outputOptions)
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
        if (subtitlesPath) await unlink(subtitlesPath);
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
   * 🆕 НОВЫЙ МЕТОД: Получение длительности аудио файла
   */
  private async getAudioDuration(audioPath: string, sessionId: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, metadata) => {
        if (err) {
          this.logger.error(`[${sessionId}] Error getting audio duration:`, err);
          reject(err);
          return;
        }

        const duration = metadata.format.duration || 30;
        resolve(duration);
      });
    });
  }

  /**
   * 🆕 НОВЫЙ МЕТОД: Генерация SRT файла из субтитров
   */
  private async generateSrtFile(captions: any[], outputPath: string): Promise<void> {
    let srtContent = '';
    
    for (let i = 0; i < captions.length; i++) {
      const caption = captions[i];
      const startTime = this.formatSrtTime(caption.start);
      const endTime = this.formatSrtTime(caption.end);
      
      srtContent += `${i + 1}\n`;
      srtContent += `${startTime} --> ${endTime}\n`;
      srtContent += `${caption.text}\n\n`;
    }

    await writeFile(outputPath, srtContent, 'utf-8');
  }

  /**
   * 🆕 НОВЫЙ МЕТОД: Форматирование времени в SRT формат (00:00:00,000)
   */
  private formatSrtTime(milliseconds: number): string {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const ms = milliseconds % 1000;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
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