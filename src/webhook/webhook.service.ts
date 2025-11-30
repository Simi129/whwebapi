import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private supabase: SupabaseClient;

  constructor(private configService: ConfigService) {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase credentials');
    }

    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  async handleWhopWebhook(payload: any): Promise<{ success: boolean; action: string; userId: string }> {
    const action = payload.action || payload.type;
    const data = payload.data || payload;

    this.logger.log('Received webhook:', { action, payload });

    const userId = data.user_id || data.user?.id || data.membership?.user_id;

    if (!userId) {
      this.logger.error('No user_id found in webhook payload');
      throw new Error('Missing user_id');
    }

    switch (action) {
      case 'membership_activated':
      case 'membership.activated':
      case 'membership.went_valid':
        const { error: activateError } = await this.supabase
          .from('users')
          .update({
            subscription_status: 'active',
            subscription_plan: data.plan_id || data.membership?.plan_id || null,
          })
          .eq('whop_user_id', userId);

        if (activateError) {
          this.logger.error('Error activating membership:', activateError);
          throw new Error('Database error');
        }

        this.logger.log(`User ${userId} subscription activated`);
        break;

      case 'membership_deactivated':
      case 'membership.deactivated':
      case 'membership.went_invalid':
        const { error: deactivateError } = await this.supabase
          .from('users')
          .update({
            subscription_status: 'inactive',
            subscription_plan: null,
          })
          .eq('whop_user_id', userId);

        if (deactivateError) {
          this.logger.error('Error deactivating membership:', deactivateError);
          throw new Error('Database error');
        }

        this.logger.log(`User ${userId} subscription deactivated`);
        break;

      case 'payment_succeeded':
      case 'payment.succeeded':
        const { data: user, error: fetchError } = await this.supabase
          .from('users')
          .select('credits')
          .eq('whop_user_id', userId)
          .single();

        if (fetchError) {
          this.logger.error('Error fetching user:', fetchError);
        }

        if (user) {
          const { error: creditError } = await this.supabase
            .from('users')
            .update({ credits: user.credits + 100 })
            .eq('whop_user_id', userId);

          if (creditError) {
            this.logger.error('Error adding credits:', creditError);
            throw new Error('Database error');
          }

          this.logger.log(`Added 100 credits to user ${userId}`);
        } else {
          this.logger.log(`User ${userId} not found, skipping credit addition`);
        }
        break;

      default:
        this.logger.log(`Unhandled webhook action: ${action}`);
    }

    return { success: true, action, userId };
  }
}
