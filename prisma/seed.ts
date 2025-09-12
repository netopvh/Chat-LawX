import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seed do banco de dados Chat LawX...');
  
  // ===== SEEDS PARA PLANOS =====
  console.log('📋 Criando planos por jurisdição...');
  
  // Planos para Portugal (DDI 351)
  const plansPT = [
    {
      name: 'Fremium',
      description: 'Plano gratuito com 2 consultas jurídicas',
      monthlyPrice: 0,
      yearlyPrice: 0,
      consultationLimit: 2,
      documentAnalysisLimit: 1,
      messageLimit: 2,
      isUnlimited: false,
      isActive: true,
      jurisdiction: 'PT',
      ddi: '351',
      features: [
        '2 consultas jurídicas gratuitas',
        '1 análise de documento',
        'Suporte básico via WhatsApp',
        'Respostas em português de Portugal'
      ]
    },
    {
      name: 'Pro',
      description: 'Plano profissional para advogados e empresas',
      monthlyPrice: 29.90,
      yearlyPrice: 299.00,
      consultationLimit: 50,
      documentAnalysisLimit: 20,
      messageLimit: 100,
      isUnlimited: false,
      isActive: true,
      jurisdiction: 'PT',
      ddi: '351',
      features: [
        '50 consultas jurídicas por mês',
        '20 análises de documentos',
        '100 mensagens por mês',
        'Suporte prioritário',
        'Respostas em português de Portugal',
        'Análise de contratos',
        'Pareceres jurídicos'
      ]
    },
    {
      name: 'Premium',
      description: 'Plano premium com recursos ilimitados',
      monthlyPrice: 59.90,
      yearlyPrice: 599.00,
      consultationLimit: null,
      documentAnalysisLimit: null,
      messageLimit: null,
      isUnlimited: true,
      isActive: true,
      jurisdiction: 'PT',
      ddi: '351',
      features: [
        'Consultas jurídicas ilimitadas',
        'Análises de documentos ilimitadas',
        'Mensagens ilimitadas',
        'Suporte 24/7',
        'Respostas em português de Portugal',
        'Análise de contratos avançada',
        'Pareceres jurídicos detalhados',
        'Acesso a jurisprudência',
        'Relatórios personalizados'
      ]
    }
  ];

  // Planos para Espanha (DDI 34)
  const plansES = [
    {
      name: 'Fremium',
      description: 'Plan gratuito con 2 consultas jurídicas',
      monthlyPrice: 0,
      yearlyPrice: 0,
      consultationLimit: 2,
      documentAnalysisLimit: 1,
      messageLimit: 2,
      isUnlimited: false,
      isActive: true,
      jurisdiction: 'ES',
      ddi: '34',
      features: [
        '2 consultas jurídicas gratuitas',
        '1 análisis de documento',
        'Soporte básico via WhatsApp',
        'Respuestas en español'
      ]
    },
    {
      name: 'Pro',
      description: 'Plan profesional para abogados y empresas',
      monthlyPrice: 29.90,
      yearlyPrice: 299.00,
      consultationLimit: 50,
      documentAnalysisLimit: 20,
      messageLimit: 100,
      isUnlimited: false,
      isActive: true,
      jurisdiction: 'ES',
      ddi: '34',
      features: [
        '50 consultas jurídicas por mes',
        '20 análisis de documentos',
        '100 mensajes por mes',
        'Soporte prioritario',
        'Respuestas en español',
        'Análisis de contratos',
        'Dictámenes jurídicos'
      ]
    },
    {
      name: 'Premium',
      description: 'Plan premium con recursos ilimitados',
      monthlyPrice: 59.90,
      yearlyPrice: 599.00,
      consultationLimit: null,
      documentAnalysisLimit: null,
      messageLimit: null,
      isUnlimited: true,
      isActive: true,
      jurisdiction: 'ES',
      ddi: '34',
      features: [
        'Consultas jurídicas ilimitadas',
        'Análisis de documentos ilimitados',
        'Mensajes ilimitados',
        'Soporte 24/7',
        'Respuestas en español',
        'Análisis de contratos avanzada',
        'Dictámenes jurídicos detallados',
        'Acceso a jurisprudencia',
        'Informes personalizados'
      ]
    }
  ];

  // Inserir planos para Portugal
  for (const plan of plansPT) {
    await prisma.plan.upsert({
      where: {
        name_jurisdiction: {
          name: plan.name,
          jurisdiction: plan.jurisdiction
        }
      },
      update: plan,
      create: plan
    });
    console.log(`✅ Plano ${plan.name} (${plan.jurisdiction}) criado/atualizado`);
  }

  // Inserir planos para Espanha
  for (const plan of plansES) {
    await prisma.plan.upsert({
      where: {
        name_jurisdiction: {
          name: plan.name,
          jurisdiction: plan.jurisdiction
        }
      },
      update: plan,
      create: plan
    });
    console.log(`✅ Plano ${plan.name} (${plan.jurisdiction}) criado/atualizado`);
  }

  // ===== SEEDS PARA PROMPTS LEGAIS =====
  console.log('⚖️ Criando prompts legais por jurisdição...');

  const legalPrompts = [
    {
      jurisdiction: 'BR',
      name: 'Assistente Jurídico Brasil',
      description: 'Assistente especializado em legislação brasileira',
      content: `Você é um assistente jurídico especializado em legislação brasileira. Sua função é fornecer orientações jurídicas precisas e atualizadas baseadas no ordenamento jurídico brasileiro.

COMPETÊNCIAS:
- Código Civil Brasileiro (Lei 10.406/2002)
- Código Penal Brasileiro (Decreto-Lei 2.848/1940)
- Consolidação das Leis do Trabalho (CLT - Decreto-Lei 5.452/1943)
- Constituição Federal de 1988
- Código de Defesa do Consumidor (Lei 8.078/1990)
- Código de Processo Civil (Lei 13.105/2015)
- Código de Processo Penal (Decreto-Lei 3.689/1941)

DIRETRIZES:
1. Sempre cite as leis, artigos e jurisprudência relevantes
2. Explique conceitos jurídicos de forma clara e acessível
3. Indique quando é necessário consultar um advogado
4. Mantenha-se atualizado com as mudanças legislativas
5. Forneça orientações práticas e aplicáveis
6. Respeite o sigilo profissional e a ética jurídica

FORMATO DE RESPOSTA:
- Resposta clara e objetiva
- Referências legais específicas
- Sugestões práticas quando aplicável
- Indicação de necessidade de consulta jurídica quando necessário

Lembre-se: Você é um assistente, não substitui a consulta com um advogado qualificado.`,
      isActive: true
    },
    {
      jurisdiction: 'PT',
      name: 'Assistente Jurídico Portugal',
      description: 'Assistente especializado em legislação portuguesa',
      content: `Você é um assistente jurídico especializado em legislação portuguesa. Sua função é fornecer orientações jurídicas precisas e atualizadas baseadas no ordenamento jurídico português.

COMPETÊNCIAS:
- Código Civil Português (Decreto-Lei 47.344/1966)
- Código Penal Português (Decreto-Lei 48/95)
- Código do Trabalho (Lei 7/2009)
- Constituição da República Portuguesa
- Código de Processo Civil (Lei 41/2013)
- Código de Processo Penal (Decreto-Lei 78/87)
- Lei de Proteção de Dados (RGPD)

DIRETRIZES:
1. Sempre cite as leis, artigos e jurisprudência relevantes
2. Explique conceitos jurídicos de forma clara e acessível
3. Indique quando é necessário consultar um advogado
4. Mantenha-se atualizado com as mudanças legislativas
5. Forneça orientações práticas e aplicáveis
6. Respeite o sigilo profissional e a ética jurídica
7. Use terminologia jurídica portuguesa adequada

FORMATO DE RESPOSTA:
- Resposta clara e objetiva
- Referências legais específicas
- Sugestões práticas quando aplicável
- Indicação de necessidade de consulta jurídica quando necessário

Lembre-se: Você é um assistente, não substitui a consulta com um advogado qualificado.`,
      isActive: true
    },
    {
      jurisdiction: 'ES',
      name: 'Assistente Jurídico Espanha',
      description: 'Assistente especializado em legislação espanhola',
      content: `Eres un asistente jurídico especializado en legislación española. Tu función es proporcionar orientaciones jurídicas precisas y actualizadas basadas en el orderamiento jurídico español.

COMPETENCIAS:
- Código Civil Español (Real Decreto de 24 de julio de 1889)
- Código Penal Español (Ley Orgánica 10/1995)
- Estatuto de los Trabajadores (Real Decreto Legislativo 2/2015)
- Constitución Española de 1978
- Ley de Enjuiciamiento Civil (Ley 1/2000)
- Ley de Enjuiciamiento Criminal (Ley 14/1882)
- Ley Orgánica de Protección de Datos (LOPD-GDD)

DIRECTRICES:
1. Siempre cita las leyes, artículos y jurisprudencia relevantes
2. Explica conceptos jurídicos de forma clara y accesible
3. Indica cuándo es necesario consultar a un abogado
4. Mantente actualizado con los cambios legislativos
5. Proporciona orientaciones prácticas y aplicables
6. Respeta el secreto profesional y la ética jurídica
7. Usa terminología jurídica española adecuada

FORMATO DE RESPUESTA:
- Respuesta clara y objetiva
- Referencias legales específicas
- Sugerencias prácticas cuando sea aplicable
- Indicación de necesidad de consulta jurídica cuando sea necesario

Recuerda: Eres un asistente, no sustituyes la consulta con un abogado cualificado.`,
      isActive: true
    }
  ];

  // Inserir prompts legais
  for (const prompt of legalPrompts) {
    await prisma.legalPrompt.upsert({
      where: {
        jurisdiction_name: {
          jurisdiction: prompt.jurisdiction,
          name: prompt.name
        }
      },
      update: prompt,
      create: prompt
    });
    console.log(`✅ Prompt ${prompt.name} (${prompt.jurisdiction}) criado/atualizado`);
  }

  console.log('✅ Seed concluído com sucesso!');
  console.log('📊 Resumo:');
  console.log(`   - ${plansPT.length + plansES.length} planos criados (PT: ${plansPT.length}, ES: ${plansES.length})`);
  console.log(`   - ${legalPrompts.length} prompts legais criados`);
  console.log('🎯 Sistema pronto para uso!');
}

main()
  .catch((e) => {
    console.error('❌ Erro durante o seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
