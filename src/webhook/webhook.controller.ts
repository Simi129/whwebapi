import { Controller, Post, Body, HttpException, HttpStatus } from '@nestjs/common';
import { WebhookService } from './webhook.service';

@Controller('api')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post('whop-webhook')
  async handleWhopWebhook(@Body() payload: any) {
    try {
      const result = await this.webhookService.handleWhopWebhook(payload);
      return result;
    } catch (error) {
      throw new HttpException(
        error.message || 'Webhook processing failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
