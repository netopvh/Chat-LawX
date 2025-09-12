import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { UsageService } from '../usage/usage.service';
import { JurisdictionService } from '../jurisdiction/jurisdiction.service';
import { TeamsService } from '../teams/teams.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';

export interface User {
  id: string;
  phone: string;
  name: string;
  is_registered: boolean;
  jurisdiction?: string;
  ddi?: string;
  legal_specialty?: string;
  oab_number?: string;
  team_id?: string;
  stripe_customer_id?: string;
  preferred_language?: string;
  timezone?: string;
  is_verified?: boolean;
  messages_count?: number;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class UsersService {
  constructor(
    private supabaseService: SupabaseService,
    private subscriptionsService: SubscriptionsService,
    private usageService: UsageService,
    private jurisdictionService: JurisdictionService,
    private teamsService: TeamsService,
    private prismaService: PrismaService,
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
    
    // Detectar jurisdição baseada no número de telefone
    const jurisdiction = this.jurisdictionService.detectJurisdiction(phone);
    console.log(`🌍 Jurisdição detectada: ${jurisdiction.jurisdiction} para ${phone}`);
    
    // Para usuários brasileiros, buscar no Supabase teams
    if (jurisdiction.jurisdiction === 'BR') {
      return await this.getBrazilianUser(phone, jurisdiction);
    }
    
    // Para Portugal/Espanha, usar Prisma local
    return await this.getLocalUser(phone, jurisdiction);
  }

  /**
   * Busca ou cria usuário brasileiro (Supabase teams)
   */
  private async getBrazilianUser(phone: string, jurisdiction: any): Promise<User> {
    try {
      // Buscar no Supabase teams
      const teamUser = await this.teamsService.findUserByPhone(phone);
      
      if (teamUser) {
        return {
          id: teamUser.id,
          phone: teamUser.phone,
          name: teamUser.name || '',
          is_registered: true,
          jurisdiction: jurisdiction.jurisdiction,
          ddi: jurisdiction.ddi,
          team_id: teamUser.team_id,
          created_at: teamUser.created_at,
          updated_at: teamUser.updated_at,
        };
      }
      
      // Se não encontrou, criar usuário básico
      const { data, error } = await this.supabaseService.getClient()
        .auth.admin.createUser({
          phone,
          user_metadata: {
            is_registered: false,
            jurisdiction: jurisdiction.jurisdiction,
            ddi: jurisdiction.ddi,
          },
          email_confirm: true,
        });

      if (error) {
        console.error('❌ Erro ao criar usuário brasileiro:', error);
        throw new Error(`Erro ao criar usuário brasileiro: ${error.message}`);
      }
      
      return {
        id: data.user.id,
        phone: data.user.phone || phone,
        name: '',
        is_registered: false,
        jurisdiction: jurisdiction.jurisdiction,
        ddi: jurisdiction.ddi,
        created_at: data.user.created_at,
        updated_at: data.user.updated_at,
      };
    } catch (error) {
      console.error('❌ Erro crítico ao criar usuário brasileiro:', error);
      throw error;
    }
  }

  /**
   * Busca ou cria usuário local (Portugal/Espanha - Prisma)
   */
  private async getLocalUser(phone: string, jurisdiction: any): Promise<User> {
    try {
      // Buscar no MySQL local via Prisma
      const localUser = await this.prismaService.findUserByPhone(phone);
      
      if (localUser) {
        return {
          id: localUser.id,
          phone: localUser.phone,
          name: localUser.name || '',
          is_registered: true,
          jurisdiction: localUser.jurisdiction,
          ddi: localUser.ddi,
          messages_count: localUser.messagesCount,
          created_at: localUser.createdAt.toISOString(),
          updated_at: localUser.updatedAt.toISOString(),
        };
      }
      
      // Se não encontrou, criar usuário local
      const newUser = await this.prismaService.createUser({
        phone,
        ddi: jurisdiction.ddi,
        jurisdiction: jurisdiction.jurisdiction,
        name: '',
        messagesCount: 0,
      });
      
      return {
        id: newUser.id,
        phone: newUser.phone,
        name: newUser.name || '',
        is_registered: false,
        jurisdiction: newUser.jurisdiction,
        ddi: newUser.ddi,
        messages_count: newUser.messagesCount,
        created_at: newUser.createdAt.toISOString(),
        updated_at: newUser.updatedAt.toISOString(),
      };
    } catch (error) {
      console.error('❌ Erro ao buscar/criar usuário local:', error);
      throw error;
    }
  }

  /**
   * Registra usuário com informações jurídicas
   */
  async registerUserWithLegalInfo(
    phone: string, 
    name: string, 
    legalSpecialty?: string,
    oabNumber?: string
  ): Promise<User> {
    const jurisdiction = this.jurisdictionService.detectJurisdiction(phone);
    
    if (jurisdiction.jurisdiction === 'BR') {
      // Para Brasil, atualizar no Supabase
      return await this.registerBrazilianUser(phone, name, legalSpecialty, oabNumber);
    } else {
      // Para Portugal/Espanha, atualizar no MySQL local
      return await this.registerLocalUser(phone, name, legalSpecialty);
    }
  }

  private async registerBrazilianUser(
    phone: string, 
    name: string, 
    legalSpecialty?: string,
    oabNumber?: string
  ): Promise<User> {
    const user = await this.findByPhone(phone);
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    // Atualizar metadata do usuário
    const { data, error } = await this.supabaseService.getClient()
      .auth.admin.updateUserById(user.id, {
        user_metadata: {
          name,
          is_registered: true,
          legal_specialty: legalSpecialty,
          oab_number: oabNumber,
          jurisdiction: 'BR',
          ddi: '55',
        },
      });

    if (error) throw new Error('Erro ao atualizar usuário brasileiro');
    
    return {
      ...user,
      name,
      is_registered: true,
      legal_specialty: legalSpecialty,
      oab_number: oabNumber,
      jurisdiction: 'BR',
      ddi: '55',
    };
  }

  private async registerLocalUser(
    phone: string, 
    name: string, 
    legalSpecialty?: string
  ): Promise<User> {
    const updatedUser = await this.prismaService.updateUser(phone, {
      name,
      legalSpecialty,
    });

    return {
      id: updatedUser.id,
      phone: updatedUser.phone,
      name: updatedUser.name || '',
      is_registered: true,
      jurisdiction: updatedUser.jurisdiction,
      ddi: updatedUser.ddi,
      legal_specialty: legalSpecialty,
      messages_count: updatedUser.messagesCount,
      created_at: updatedUser.createdAt.toISOString(),
      updated_at: updatedUser.updatedAt.toISOString(),
    };
  }
} 