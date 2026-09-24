import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type {
  BuildDetail,
  PaginatedData,
  BuildSummary,
} from '../api/types.js';
import { createBaseEmbed, createResponseEmbed } from '../embeds/theme.js';
import { createBuildImage } from '../services/build-image.js';
import { buildDisplayName, findBuildMatches } from '../services/build-lookup.js';

export const data = new SlashCommandBuilder()
  .setName('build')
  .setDescription('Mostra una build con tutti gli item in una sola immagine')
  .addStringOption((option) =>
    option
      .setName('nome')
      .setDescription('Nome completo: Nome Categoria Creatore, senza trattini')
      .setRequired(true),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply();

  const query = interaction.options.getString('nome', true).trim();
  const result = await api.get<PaginatedData<BuildSummary>>(
    'api/comps/builds',
    interaction.user.id,
    { page: 1, limit: 1000, sort: 'name', order: 'asc' },
  );
  const matches = findBuildMatches(result.items, query);

  if (matches.length === 0) {
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          'warning',
          'Build non trovata',
          'Usa il nome completo nel formato `Nome Categoria Creatore`, senza usare `-`.',
          'BUILD',
        ),
      ],
    });
    return;
  }

  if (matches.length > 1) {
    const choices = matches
      .slice(0, 20)
      .map((build) => `• \`${buildDisplayName(build)}\``)
      .join('\n');
    const suffix = matches.length > 20 ? `\n… e altre ${matches.length - 20}.` : '';
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          'warning',
          'Più varianti trovate',
          `Specifica il nome completo della variante:\n${choices}${suffix}`,
          'BUILD',
        ),
      ],
    });
    return;
  }

  const summary = matches[0];
  const build = await api.get<BuildDetail>(
    `api/comps/builds/${summary.id}`,
    interaction.user.id,
  );
  const image = await createBuildImage(build.items);
  const attachment = new AttachmentBuilder(image, { name: 'build.png' });
  const itemList = build.items
    .map((item) => `**${item.slot.replace('_', ' ')}** — ${item.openalbion_item_name}`)
    .join('\n');
  const embed = createBaseEmbed({
    category: 'BUILD',
    title: buildDisplayName(build),
    description: [
      `Categoria: **${build.category_name ?? 'Senza categoria'}**`,
      `Creatore: **${build.created_by_username}**`,
      `Ruolo: **${build.role}**`,
    ].join('\n'),
  })
    .setImage('attachment://build.png')
    .addFields({ name: 'Item', value: itemList.slice(0, 1024) || 'Nessun item' });

  await interaction.editReply({ embeds: [embed], files: [attachment] });
}
