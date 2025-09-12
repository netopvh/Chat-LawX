import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { UsageService } from '../usage/usage.service';
import { CreateUserDto } from './dto/create-user.dto';

export interface User {
  id: string;
  phone: string;
  name: string;
  is_registered: boolean;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class UsersService {
  constructor(
    private supabaseService: SupabaseService,
    private subscriptionsService: SubscriptionsService,
    private usageService: UsageService,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<User> {
    console.log('👤 Criando usuário:', JSON.stringify(createUserDto, null, 2));
    
    const existingUser = await this.findByPhone(createUserDto.phone);
    
    if (existingUser) {
      console.log('⚠️ Usuário já existe:', existingUser.id);
      throw new ConflictException('Usuário já existe com este telefone');
    }

    // Usar a tabela auth.users nativa do Supabase
    console.log('👤 Criando usuário no Supabase Auth...');
    const { data, error } = await this.supabaseService.getClient()
      .auth.admin.createUser({
        phone: createUserDto.phone,
        user_metadata: {
          name: createUserDto.name,
          is_registered: true,
        },
        email_confirm: true, // Confirmar automaticamente
      });

    if (error) {
      console.error('❌ Erro ao criar usuário no Supabase:', error);
      throw new Error(`Erro ao criar usuário: ${error.message}`);
    }
    
    console.log('✅ Usuário criado com sucesso:', data.user.id);
    
    // Criar assinatura Fremium automaticamente
    try {
      console.log('💳 Criando assinatura Fremium para o usuário...');
      await this.subscriptionsService.createFremiumSubscription(data.user.id);
      console.log('✅ Assinatura Fremium criada com sucesso');
      
      // Inicializar tracking de uso
      console.log('📊 Inicializando tracking de uso...');
      await this.usageService.initializeUsageTracking(data.user.id);
      console.log('✅ Tracking de uso inicializado');
    } catch (subscriptionError) {
      console.error('❌ Erro ao criar assinatura Fremium:', subscriptionError);
      // Não falhar o cadastro se houver erro na assinatura
    }
    
    return {
      id: data.user.id,
      phone: data.user.phone || createUserDto.phone,
      name: createUserDto.name,
      is_registered: true,
      created_at: data.user.created_at,
      updated_at: data.user.updated_at,
    };
  }

  async findByPhone(phone: string): Promise<User | null> {
    console.log('🔍 Buscando usuário por telefone:', phone);
    
    // Buscar na tabela auth.users usando RPC
    const { data, error } = await this.supabaseService.getClient()
      .rpc('get_user_by_phone', { phone_number: phone });

    if (error) {
      console.log('🔍 Erro na busca:', error.code, error.message);
      return null;
    }
    
    if (!data) {
      console.log('🔍 Usuário não encontrado');
      return null;
    }

    console.log('🔍 Usuário encontrado:', data.id);
    console.log('🔍 Metadata:', JSON.stringify(data.raw_user_meta_data, null, 2));

    return {
      id: data.id,
      phone: data.phone,
      name: data.raw_user_meta_data?.name || '',
      is_registered: data.raw_user_meta_data?.is_registered || false,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  }

  async findById(id: string): Promise<User> {
    const { data, error } = await this.supabaseService.getClient()
      .rpc('get_user_by_id', { user_id: id });
    
    if (error) {
      console.log('🔍 Erro na busca por ID:', error.code, error.message);
      throw new NotFoundException('Usuário não encontrado');
    }

    if (!data) {
      console.log('🔍 Usuário não encontrado por ID:', id);
      throw new NotFoundException('Usuário não encontrado');
    }

    return {
      id: data.id,
      phone: data.phone,
      name: data.raw_user_meta_data?.name || '',
      is_registered: data.raw_user_meta_data?.is_registered || false,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  }

  async registerUser(phone: string, name: string): Promise<User> {
    const existingUser = await this.findByPhone(phone);
    
    if (existingUser) {
      if (!existingUser.is_registered) {
        // Atualizar metadata do usuário
        const { data, error } = await this.supabaseService.getClient()
          .auth.admin.updateUserById(existingUser.id, {
            user_metadata: {
              name,
              is_registered: true,
            },
          });

        if (error) throw new Error('Erro ao atualizar usuário');
        
        // Criar assinatura Fremium automaticamente
        try {
          console.log('💳 Criando assinatura Fremium para usuário existente...');
          await this.subscriptionsService.createFremiumSubscription(data.user.id);
          console.log('✅ Assinatura Fremium criada com sucesso');
          
          // Inicializar tracking de uso
          console.log('📊 Inicializando tracking de uso...');
          await this.usageService.initializeUsageTracking(data.user.id);
          console.log('✅ Tracking de uso inicializado');
        } catch (subscriptionError) {
          console.error('❌ Erro ao criar assinatura Fremium:', subscriptionError);
          // Não falhar o registro se houver erro na assinatura
        }
        
        return {
          id: data.user.id,
          phone: data.user.phone || phone,
          name,
          is_registered: true,
          created_at: data.user.created_at,
          updated_at: data.user.updated_at,
        };
      }
      return existingUser;
    }

    return this.create({ phone, name });
  }

  async getOrCreateUser(phone: string): Promise<User> {
    console.log('👤 Buscando ou criando usuário para:', phone);
    
    let user = await this.findByPhone(phone);
    
    if (!user) {
      console.log('👤 Usuário não encontrado, criando novo...');
      
      try {
        // Criar usuário básico sem nome
        const { data, error } = await this.supabaseService.getClient()
          .auth.admin.createUser({
            phone,
            user_metadata: {
              is_registered: false,
            },
            email_confirm: true,
          });

        if (error) {
          console.error('❌ Erro ao criar usuário básico:', error);
          
          // Se o telefone já existe, tentar buscar novamente
          if (error.message.includes('already registered')) {
            console.log('🔄 Telefone já registrado, tentando buscar novamente...');
            user = await this.findByPhone(phone);
            if (user) {
              console.log('✅ Usuário encontrado após erro:', user.id);
              return user;
            }
          }
          
          throw new Error(`Erro ao criar usuário: ${error.message}`);
        }
        
        console.log('✅ Usuário básico criado:', data.user.id);
        
        user = {
          id: data.user.id,
          phone: data.user.phone || phone,
          name: '',
          is_registered: false,
          created_at: data.user.created_at,
          updated_at: data.user.updated_at,
        };
      } catch (error) {
        console.error('❌ Erro crítico ao criar usuário:', error);
        throw error;
      }
    } else {
      console.log('👤 Usuário encontrado:', user.id);
    }

    return user;
  }
} 