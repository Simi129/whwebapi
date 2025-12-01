import { Controller, Post, Body, HttpException, HttpStatus } from '@nestjs/common';
import { VideoService } from './video.service';
import { GenerateScriptDto } from './dto/generate-script.dto';
import { GenerateAudioDto } from './dto/generate-audio.dto';
import { GenerateImageDto } from './dto/generate-image.dto';
import { GenerateImagesDto } from './dto/generate-images.dto';
import { GenerateCaptionsDto } from './dto/generate-captions.dto';
import { RenderVideoDto } from './dto/render-video.dto';

@Controller('api')
export class VideoController {
  constructor(private readonly videoService: VideoService) {}

  @Post('generate-script')
  async generateScript(@Body() dto: GenerateScriptDto) {
    try {
      const script = await this.videoService.generateScript(dto.prompt);
      return { script };
    } catch (error) {
      console.error('Script generation error:', error);
      throw new HttpException(
        error.message || 'Unknown error',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('generate-audio')
  async generateAudio(@Body() dto: GenerateAudioDto) {
    try {
      const result = await this.videoService.generateAudio(dto.text);
      return result;
    } catch (error) {
      console.error('Audio generation error:', error);
      throw new HttpException(
        error.message || 'Unknown error',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('generate-image')
  async generateImage(@Body() dto: GenerateImageDto) {
    try {
      const result = await this.videoService.generateImage(dto.prompt);
      return result;
    } catch (error) {
      console.error('Image generation error:', error);
      throw new HttpException(
        error.message || 'Unknown error',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('generate-images')
  async generateImages(@Body() dto: GenerateImagesDto) {
    try {
      const result = await this.videoService.generateImages(dto.prompts);
      return result;
    } catch (error) {
      console.error('Images generation error:', error);
      throw new HttpException(
        error.message || 'Unknown error',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('generate-captions')
  async generateCaptions(@Body() dto: GenerateCaptionsDto) {
    try {
      const captions = await this.videoService.generateCaptions(dto.audioFileUrl);
      return { captions };
    } catch (error) {
      console.error('Caption generation error:', error);
      throw new HttpException(
        error.message || 'Unknown error',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * ОПТИМИЗИРОВАННЫЙ эндпоинт: рендеринг видео по ID
   * Принимает только videoId, все данные загружаются из Supabase
   */
  @Post('render-video')
  async renderVideo(@Body() dto: RenderVideoDto) {
    try {
      const result = await this.videoService.renderVideoById(dto.videoId);
      return result;
    } catch (error) {
      console.error('Video rendering error:', error);
      throw new HttpException(
        error.message || 'Unknown error',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}